import { CognitoUserPool, CognitoUser, AuthenticationDetails } from 'amazon-cognito-identity-js';
import axios from 'axios';
import { wrapper as axiosCookieJarSupport } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import pkceChallenge from 'pkce-challenge';
import { URLSearchParams, URL } from 'url';

import { OS_HOSTNAME, OS_USERNAME, OS_PASSWORD } from './config';

/**
 * Performs the Cognito SRP login to get Cognito-specific tokens.
 */
async function cognitoLogin(username: string, password: string, hostname: string) {
    // 1. Get the Cognito configuration from the OutSystems tenant
    const configUrl = `https://${hostname}/authentication/rest/api/v1/tenant-config`;
    const configResponse = await axios.get(configUrl);
    const cognitoConfig = configResponse.data.cognitoConfig;

    const poolData = {
        UserPoolId: cognitoConfig.poolId,
        ClientId: cognitoConfig.amplifyClientId
    };

    // 2. Use the Amazon Cognito library to perform the SRP authentication
    const userPool = new CognitoUserPool(poolData);
    const authenticationDetails = new AuthenticationDetails({ Username: username, Password: password });
    const cognitoUser = new CognitoUser({ Username: username, Pool: userPool });

    return new Promise<any>((resolve, reject) => {
        cognitoUser.authenticateUser(authenticationDetails, {
            onSuccess: (result) => resolve(result),
            onFailure: (err) => reject(err),
        });
    });
}

/**
 * Main function to orchestrate the entire authentication flow.
 */
export const getOutsystemsToken = async (): Promise<string> => {
    try {
        // Create an axios instance that supports cookies to maintain session state
        const jar = new CookieJar();
        const session = axiosCookieJarSupport(axios.create());
        // Use a type assertion to fix the TypeScript error
        (session.defaults as any).jar = jar;

        // 1. Get the OIDC configuration to find the authorization and token endpoints
        const oidcConfigUrl = `https://${OS_HOSTNAME}/identity/.well-known/openid-configuration`;
        const oidcConfigResponse = await session.get(oidcConfigUrl);
        const { authorization_endpoint, token_endpoint } = oidcConfigResponse.data;

        // 2. Generate the PKCE codes needed for the auth flow
        const { code_verifier, code_challenge } = await pkceChallenge();
        const redirect_url = `https://${OS_HOSTNAME}/authentication/redirect`;

        // 3. Start the authorization flow to get state and other parameters
        const authPageParams = new URLSearchParams({
            response_type: 'code',
            client_id: 'unified_experience', // This is a specific public client for this flow
            redirect_uri: redirect_url,
            kc_idp_hint: 'cognito',
            scope: 'openid email profile',
            code_challenge: code_challenge,
            code_challenge_method: 'S256'
        });
        const authPageResponse = await session.get(`${authorization_endpoint}?${authPageParams.toString()}`);
        const responseUrl = new URL(authPageResponse.request.res.responseUrl);
        const state = responseUrl.searchParams.get('state');
        const kcUri = responseUrl.searchParams.get('redirect_uri');
        const clientPoolId = responseUrl.searchParams.get('client_id');

        if (!state || !kcUri || !clientPoolId) {
            throw new Error('Failed to retrieve state, kcUri, or clientPoolId from auth page.');
        }

        // 4. Perform the separate Cognito SRP login
        const cognitoResult = await cognitoLogin(OS_USERNAME, OS_PASSWORD, OS_HOSTNAME);
        const cognitoTokens = {
            IdToken: cognitoResult.getIdToken().getJwtToken(),
            AccessToken: cognitoResult.getAccessToken().getJwtToken(),
            RefreshToken: cognitoResult.getRefreshToken().getToken(),
        };

        // 5. Exchange Cognito tokens for an intermediate OutSystems auth code
        const storeTokenUrl = `https://${OS_HOSTNAME}/identityapi/v1alpha1/oidc/store-token`;
        const storeTokenResponse = await session.post(storeTokenUrl, {
            ClientId: clientPoolId,
            ...cognitoTokens
        });
        const codeFromIdentity = storeTokenResponse.data.authCode;

        // 6. Exchange the intermediate code for the final authorization code from Keycloak
        const keycloakUrl = `${kcUri}?code=${codeFromIdentity}&state=${state}`;
        const keycloakResponse = await session.get(keycloakUrl, { maxRedirects: 0, validateStatus: status => status >= 200 && status < 400 });
        const finalRedirectUrl = new URL(keycloakResponse.headers.location, redirect_url);
        const finalCode = finalRedirectUrl.searchParams.get('code');

        if (!finalCode) {
            throw new Error('Failed to retrieve final authorization code from Keycloak redirect.');
        }

        // 7. Exchange the final authorization code for the platform access token
        const tokenRequestData = new URLSearchParams({
            grant_type: 'authorization_code',
            code: finalCode,
            code_verifier: code_verifier,
            redirect_uri: redirect_url,
            client_id: 'unified_experience'
        });
        const tokenResponse = await session.post(token_endpoint, tokenRequestData, {
             headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        // SUCCESS!
        return tokenResponse.data.access_token;

    } catch (error: any) {
        console.error("Failed to complete OutSystems authentication flow.", error.response?.data || error.message);
        throw new Error("OutSystems authentication failed.");
    }
};

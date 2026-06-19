const inFlightRetries = new Set();
const requestCache = new Map();

function isLoginUrl(url = '') {
  return url.toLowerCase().includes('/login');
}

function jsonBody(payload) {
  return {
    mimeType: 'application/json',
    text: JSON.stringify(payload)
  };
}

function getEnvValue(context, key) {
  const value = context.request.getEnvironmentVariable(key);

  if (value === undefined || value === null) {
    return null;
  }

  return String(value).trim();
}

function getAuthConfig(context) {
  return {
    baseUrl: getEnvValue(context, 'baseURL'),
    username: getEnvValue(context, 'username'),
    password: getEnvValue(context, 'password')
  };
}

function buildLoginRequest(baseUrl, username, password) {
  return {
    _id: `auto-login-${Date.now()}`,
    name: 'Auto Login',
    method: 'POST',
    url: `${baseUrl.replace(/\/$/, '')}/login`,
    headers: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Accept', value: 'application/json' }
    ],
    body: jsonBody({ username, password }),
    settingSendCookies: true,
    settingStoreCookies: true
  };
}

function cloneRequestFromContext(req) {
  return {
    _id: req.getId(),
    name: req.getName(),
    method: req.getMethod(),
    url: req.getUrl(),
    headers: req.getHeaders(),
    body: req.getBody(),
    parameters: req.getParameters?.() || [],
    authentication: req.getAuthentication?.(),
    settingSendCookies: true,
    settingStoreCookies: true
  };
}

module.exports.requestHooks = [
  context => {
    const req = context.request;

    requestCache.set(req.getId(), {
      request: cloneRequestFromContext(req)
    });
  }
];

module.exports.responseHooks = [
  async context => {
    const statusCode = context.response.getStatusCode();

    if (statusCode !== 401) return;

    const requestId = context.response.getRequestId();
    const cached = requestCache.get(requestId);

    if (!cached) return;

    const originalRequest = cached.request;

    if (isLoginUrl(originalRequest.url)) return;
    if (inFlightRetries.has(requestId)) return;

    inFlightRetries.add(requestId);

    try {
      const { baseUrl, username, password } = getAuthConfig(context);

      if (!baseUrl || !username || !password) {
        context.response.setBody(
          Buffer.from(
            JSON.stringify(
              {
                error: 'Auto login failed',
                message:
                  'Missing baseURL, username, or password in environment.'
              },
              null,
              2
            ),
            'utf8'
          )
        );
        return;
      }

      const loginRequest = buildLoginRequest(baseUrl, username, password);

      const loginResponse = await context.network.sendRequest(loginRequest);

      const loginStatusCode =
        typeof loginResponse.getStatusCode === 'function'
          ? loginResponse.getStatusCode()
          : loginResponse.statusCode;

      if (loginStatusCode < 200 || loginStatusCode >= 300) {
        context.response.setBody(
          Buffer.from(
            JSON.stringify(
              {
                error: 'Auto login failed',
                loginStatusCode
              },
              null,
              2
            ),
            'utf8'
          )
        );
        return;
      }

      // Retry happens here after login updates Insomnia's cookie jar.
      const retriedResponse = await context.network.sendRequest(originalRequest);

      const retriedBody =
        typeof retriedResponse.getBody === 'function'
          ? retriedResponse.getBody()
          : retriedResponse.body;

      if (retriedBody) {
        context.response.setBody(
          Buffer.isBuffer(retriedBody)
            ? retriedBody
            : Buffer.from(String(retriedBody), 'utf8')
        );
      }
    } catch (error) {
      context.response.setBody(
        Buffer.from(
          JSON.stringify(
            {
              error: 'Auto refresh plugin failed',
              message: error.message
            },
            null,
            2
          ),
          'utf8'
        )
      );
    } finally {
      inFlightRetries.delete(requestId);
    }
  }
];
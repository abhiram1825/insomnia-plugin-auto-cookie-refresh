const inFlightRetries = new Set();
const requestCache = new Map();

function isLoginUrl(url = '', loginPath = '/login') {
  return url.toLowerCase().includes(loginPath.toLowerCase());
}

function normalizePath(path = '/login') {
  if (!path) return '/login';
  return path.startsWith('/') ? path : `/${path}`;
}

function joinUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, '')}${normalizePath(path)}`;
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

  const stringValue = String(value).trim();

  return stringValue.length ? stringValue : null;
}

function getAuthConfig(context) {
  return {
    baseUrl: getEnvValue(context, 'baseURL'),
    loginPath: getEnvValue(context, 'loginPath') || '/login',
    username: getEnvValue(context, 'username'),
    password: getEnvValue(context, 'password'),
    usernameField: getEnvValue(context, 'usernameField') || 'username',
    passwordField: getEnvValue(context, 'passwordField') || 'password'
  };
}

function buildLoginRequest(config) {
  const payload = {
    [config.usernameField]: config.username,
    [config.passwordField]: config.password
  };

  return {
    _id: `auto-login-${Date.now()}`,
    name: 'Auto Login',
    method: 'POST',
    url: joinUrl(config.baseUrl, config.loginPath),
    headers: [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Accept', value: 'application/json' }
    ],
    body: jsonBody(payload),
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

function getStatusCode(response) {
  if (typeof response.getStatusCode === 'function') {
    return response.getStatusCode();
  }

  return response.statusCode;
}

function getResponseBody(response) {
  if (typeof response.getBody === 'function') {
    return response.getBody();
  }

  return response.body;
}

function setJsonResponse(context, payload) {
  context.response.setBody(
    Buffer.from(JSON.stringify(payload, null, 2), 'utf8')
  );
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
    const config = getAuthConfig(context);

    if (isLoginUrl(originalRequest.url, config.loginPath)) return;
    if (inFlightRetries.has(requestId)) return;

    inFlightRetries.add(requestId);

    try {
      if (!config.baseUrl || !config.username || !config.password) {
        setJsonResponse(context, {
          error: 'Auto login failed',
          message:
            'Missing baseURL, username, or password in Insomnia environment.'
        });
        return;
      }

      const loginRequest = buildLoginRequest(config);
      const loginResponse = await context.network.sendRequest(loginRequest);
      const loginStatusCode = getStatusCode(loginResponse);

      if (loginStatusCode < 200 || loginStatusCode >= 300) {
        setJsonResponse(context, {
          error: 'Auto login failed',
          loginStatusCode
        });
        return;
      }

      // Retry happens here after login updates Insomnia's cookie jar.
      const retriedResponse = await context.network.sendRequest(originalRequest);
      const retriedBody = getResponseBody(retriedResponse);

      if (retriedBody) {
        context.response.setBody(
          Buffer.isBuffer(retriedBody)
            ? retriedBody
            : Buffer.from(String(retriedBody), 'utf8')
        );
      }
    } catch (error) {
      setJsonResponse(context, {
        error: 'Auto refresh plugin failed',
        message: error.message
      });
    } finally {
      inFlightRetries.delete(requestId);
    }
  }
];
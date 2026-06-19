const PLUGIN_NAME = 'Auto Auth Cookie';
const refreshPromises = new Map();

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function normalizeDomain(value = '') {
  let domain = String(value).trim().toLowerCase();

  if (!domain) {
    return '';
  }

  try {
    if (domain.includes('://')) {
      domain = new URL(domain).hostname;
    }
  } catch {
    // Keep the provided value.
  }

  return domain
    .replace(/^\./, '')
    .replace(/:\d+$/, '');
}

function domainMatches(cookieDomain, configuredDomain) {
  const cookieHost = normalizeDomain(cookieDomain);
  const targetHost = normalizeDomain(configuredDomain);

  if (!cookieHost || !targetHost) {
    return false;
  }

  return (
    targetHost === cookieHost ||
    targetHost.endsWith(`.${cookieHost}`) ||
    cookieHost.endsWith(`.${targetHost}`)
  );
}

function decodeBase64Url(value) {
  const normalized = String(value)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    '='
  );

  return Buffer.from(padded, 'base64').toString('utf8');
}

function extractJwt(cookieValue) {
  if (!cookieValue) {
    return null;
  }

  let value = String(cookieValue);

  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep the original cookie value.
  }

  if (value.split('.').length === 3) {
    return value;
  }

  try {
    const parsed = JSON.parse(value);

    const token =
      parsed.access_token ||
      parsed.accessToken ||
      parsed.authToken ||
      parsed.token;

    return typeof token === 'string' ? token : null;
  } catch {
    return null;
  }
}

function getJwtExpiry(cookieValue) {
  const jwt = extractJwt(cookieValue);

  if (!jwt) {
    return null;
  }

  try {
    const payloadPart = jwt.split('.')[1];
    const payload = JSON.parse(decodeBase64Url(payloadPart));

    if (!payload.exp) {
      return null;
    }

    return Number(payload.exp) * 1000;
  } catch {
    return null;
  }
}

function getCookieExpiry(cookie) {
  if (!cookie) {
    return null;
  }

  const expiryCandidates = [];

  if (cookie.expires) {
    const cookieExpiry = Date.parse(cookie.expires);

    if (!Number.isNaN(cookieExpiry)) {
      expiryCandidates.push(cookieExpiry);
    }
  }

  const jwtExpiry = getJwtExpiry(cookie.value);

  if (jwtExpiry) {
    expiryCandidates.push(jwtExpiry);
  }

  if (!expiryCandidates.length) {
    // A session cookie without an explicit expiry is considered valid
    // while it remains present in Insomnia's cookie jar.
    return null;
  }

  return Math.min(...expiryCandidates);
}

function isCookieFresh(cookie, expiryBufferSeconds) {
  if (!cookie || !cookie.value) {
    return false;
  }

  const expiresAt = getCookieExpiry(cookie);

  if (!expiresAt) {
    return true;
  }

  const bufferMilliseconds =
    Math.max(0, Number(expiryBufferSeconds) || 0) * 1000;

  return Date.now() + bufferMilliseconds < expiresAt;
}

function getResponseStatusCode(response) {
  if (!response) {
    return 0;
  }

  if (typeof response.getStatusCode === 'function') {
    return Number(response.getStatusCode());
  }

  return Number(
    response.statusCode ??
    response.status ??
    response.code ??
    0
  );
}

async function showDebugAlert(context, enabled, title, message) {
  if (!enabled || !context.app?.alert) {
    return;
  }

  await context.app.alert(title, message);
}

function validateContext(context) {
  if (!context?.util?.models?.request) {
    throw new Error(
      'This Insomnia version does not expose request models to template tags.'
    );
  }

  if (!context?.util?.models?.workspace) {
    throw new Error(
      'This Insomnia version does not expose workspace models to template tags.'
    );
  }

  if (!context?.util?.models?.cookieJar) {
    throw new Error(
      'This Insomnia version does not expose the native cookie jar to template tags.'
    );
  }

  if (!context?.network?.sendRequest) {
    throw new Error(
      'This Insomnia version does not expose network.sendRequest to template tags.'
    );
  }

  if (!context?.meta?.workspaceId) {
    throw new Error(
      'Could not determine the current Insomnia workspace.'
    );
  }
}

async function getCookieJar(context) {
  const workspace =
    await context.util.models.workspace.getById(
      context.meta.workspaceId
    );

  if (!workspace) {
    throw new Error(
      `Workspace not found: ${context.meta.workspaceId}`
    );
  }

  return context.util.models.cookieJar.getOrCreateForWorkspace(
    workspace
  );
}

async function findCookie(
  context,
  configuredDomain,
  cookieName
) {
  const cookieJar = await getCookieJar(context);
  const cookies = Array.isArray(cookieJar.cookies)
    ? cookieJar.cookies
    : [];

  const matchingCookies = cookies.filter(cookie => {
    return (
      cookie?.key === cookieName &&
      domainMatches(cookie.domain, configuredDomain)
    );
  });

  if (!matchingCookies.length) {
    return null;
  }

  /*
   * Prefer the cookie with the latest expiry when duplicate cookies
   * exist for the same domain and name.
   */
  matchingCookies.sort((first, second) => {
    const firstExpiry = getCookieExpiry(first) || Infinity;
    const secondExpiry = getCookieExpiry(second) || Infinity;

    return secondExpiry - firstExpiry;
  });

  return matchingCookies[0];
}

async function waitForFreshCookie(
  context,
  configuredDomain,
  cookieName,
  expiryBufferSeconds
) {
  const attempts = 15;
  const waitMilliseconds = 100;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const cookie = await findCookie(
      context,
      configuredDomain,
      cookieName
    );

    if (isCookieFresh(cookie, expiryBufferSeconds)) {
      return cookie;
    }

    await delay(waitMilliseconds);
  }

  return null;
}

async function loadLoginRequest(context, loginRequestId) {
  const request =
    await context.util.models.request.getById(
      loginRequestId
    );

  if (!request) {
    throw new Error(
      `Could not find the selected login request: ${loginRequestId}`
    );
  }

  /*
   * Ensure this execution can send and store cookies.
   * These values are applied to the request model passed to Insomnia.
   */
  request.settingSendCookies = true;
  request.settingStoreCookies = true;

  return request;
}

async function performLogin(
  context,
  loginRequestId,
  configuredDomain,
  cookieName,
  expiryBufferSeconds,
  debugAlerts
) {
  const loginRequest = await loadLoginRequest(
    context,
    loginRequestId
  );

  const currentRequestId =
    context.meta?.requestId ||
    context.meta?.request?.id ||
    null;

  if (currentRequestId === loginRequestId) {
    throw new Error(
      'The Auto Auth Cookie template tag cannot be used inside the login request itself.'
    );
  }

  /*
   * Two attempts handle the original race condition where Insomnia may
   * remove the expired cookie while the first new cookie is being stored.
   */
  const maximumLoginAttempts = 2;

  for (
    let attempt = 1;
    attempt <= maximumLoginAttempts;
    attempt += 1
  ) {
    await showDebugAlert(
      context,
      debugAlerts,
      PLUGIN_NAME,
      `Sending login request "${loginRequest.name}" — attempt ${attempt}.`
    );

    const response =
      await context.network.sendRequest(loginRequest);

    const statusCode = getResponseStatusCode(response);

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(
        `Login request "${loginRequest.name}" failed with HTTP ${statusCode || 'unknown'}.`
      );
    }

    const freshCookie = await waitForFreshCookie(
      context,
      configuredDomain,
      cookieName,
      expiryBufferSeconds
    );

    if (freshCookie) {
      await showDebugAlert(
        context,
        debugAlerts,
        PLUGIN_NAME,
        `Login succeeded. Cookie "${cookieName}" is now available for "${configuredDomain}".`
      );

      return freshCookie;
    }

    if (attempt < maximumLoginAttempts) {
      await delay(200);
    }
  }

  throw new Error(
    `Login returned successfully, but a fresh "${cookieName}" cookie was not found in Insomnia's cookie jar for "${configuredDomain}".`
  );
}

async function getOrRefreshCookie(
  context,
  loginRequestId,
  configuredDomain,
  cookieName,
  expiryBufferSeconds,
  debugAlerts
) {
  const existingCookie = await findCookie(
    context,
    configuredDomain,
    cookieName
  );

  if (
    isCookieFresh(
      existingCookie,
      expiryBufferSeconds
    )
  ) {
    return existingCookie;
  }

  const refreshKey = [
    context.meta.workspaceId,
    loginRequestId,
    normalizeDomain(configuredDomain),
    cookieName
  ].join(':');

  if (!refreshPromises.has(refreshKey)) {
    const refreshPromise = performLogin(
      context,
      loginRequestId,
      configuredDomain,
      cookieName,
      expiryBufferSeconds,
      debugAlerts
    ).finally(() => {
      refreshPromises.delete(refreshKey);
    });

    refreshPromises.set(refreshKey, refreshPromise);
  }

  return refreshPromises.get(refreshKey);
}

module.exports.templateTags = [
  {
    name: 'autoAuthCookieValue',
    displayName: 'Auto Auth Cookie Value',

    description:
      'Return a valid cookie value. If the cookie is missing or expired, send the selected login request first.',

    /*
     * Prevent Insomnia from running login merely to display an editor
     * preview. The tag still runs when the request is actually sent.
     */
    disablePreview: () => true,

    args: [
      {
        displayName: 'Login Request',
        type: 'model',
        model: 'Request',
        description:
          'The saved Insomnia request that performs login and returns Set-Cookie.'
      },
      {
        displayName: 'Cookie Domain',
        type: 'string',
        defaultValue: '',
        placeholder: 'api.example.com',
        description:
          'Cookie domain without a path. A full URL is also accepted.'
      },
      {
        displayName: 'Cookie Name',
        type: 'string',
        defaultValue: 'authToken',
        placeholder: 'authToken',
        description:
          'Name of the authentication cookie.'
      },
      {
        displayName: 'Expiry Buffer (seconds)',
        type: 'number',
        defaultValue: 30,
        description:
          'Refresh the cookie this many seconds before it expires.'
      },
      {
        displayName: 'Show Debug Alerts',
        type: 'boolean',
        defaultValue: false,
        description:
          'Show visible Insomnia alerts when login is triggered and completed.'
      }
    ],

    async run(
      context,
      loginRequestId,
      cookieDomain,
      cookieName,
      expiryBufferSeconds,
      debugAlerts
    ) {
      validateContext(context);

      if (!loginRequestId) {
        throw new Error('A Login Request must be selected.');
      }

      if (!cookieDomain) {
        throw new Error('Cookie Domain is required.');
      }

      if (!cookieName) {
        throw new Error('Cookie Name is required.');
      }

      try {
        const cookie = await getOrRefreshCookie(
          context,
          loginRequestId,
          cookieDomain,
          cookieName,
          expiryBufferSeconds,
          Boolean(debugAlerts)
        );

        return cookie.value;
      } catch (error) {
        await showDebugAlert(
          context,
          Boolean(debugAlerts),
          `${PLUGIN_NAME} Error`,
          error.message
        );

        throw error;
      }
    }
  }
];
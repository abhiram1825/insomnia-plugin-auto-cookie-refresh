var CACHE_PREFIX = 'auto-auth-cookie:v5:';
var CACHE_INDEX_KEY = CACHE_PREFIX + 'index';

var DEFAULTS = {
  loginPath: 'api/auth/login',
  cookieName: 'authToken',
  usernameField: 'username',
  passwordField: 'password',
  contentType: 'application/json',
  fallbackTtlSeconds: 900,
  expiryBufferSeconds: 60,
  maxReuseSeconds: 720,
  timeoutMs: 10000
};

var refreshPromises = {};
var memoryStore = {};

function hasValue(value) {
  return value !== undefined &&
    value !== null &&
    String(value).trim() !== '';
}

function getContextRequest(context) {
  return context && context.request ? context.request : null;
}

function getContextStore(context) {
  return context && context.store ? context.store : null;
}

function createMemoryStore() {
  return {
    getItem: async function (key) {
      return Object.prototype.hasOwnProperty.call(memoryStore, key)
        ? memoryStore[key]
        : null;
    },
    setItem: async function (key, value) {
      memoryStore[key] = value;
    },
    removeItem: async function (key) {
      delete memoryStore[key];
    }
  };
}

function getUsableStore(context) {
  var store = getContextStore(context);

  if (
    store &&
    typeof store.getItem === 'function' &&
    typeof store.setItem === 'function' &&
    typeof store.removeItem === 'function'
  ) {
    return store;
  }

  return createMemoryStore();
}

function getMethodValue(object, methodName) {
  if (!object || typeof object[methodName] !== 'function') {
    return undefined;
  }

  try {
    return object[methodName]();
  } catch (error) {
    return undefined;
  }
}

function getAppVersion(context) {
  var app = context && context.app ? context.app : null;
  var info = getMethodValue(app, 'getInfo');

  return info && info.version ? String(info.version) : '';
}

function extractVariableName(value) {
  if (typeof value !== 'string') {
    return null;
  }

  var text = value.trim();
  var match = text.match(/^_+\.([A-Za-z0-9_.-]+)$/);

  if (match) {
    return match[1];
  }

  match = text.match(/^\{\{\s*_+\.([A-Za-z0-9_.-]+)\s*\}\}$/);

  if (match) {
    return match[1];
  }

  match = text.match(/^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/);

  if (match) {
    return match[1];
  }

  return null;
}

function getKnownEnvironment(context) {
  var request = getContextRequest(context);
  var environment;

  if (request && typeof request.getEnvironment === 'function') {
    environment = request.getEnvironment();

    if (environment) {
      return environment;
    }
  }

  environment = findValueByKey(context, 'environment', 6, []);

  if (environment) {
    return environment;
  }

  return findValueByKey(context, 'env', 6, []);
}

function getNestedValue(object, path) {
  if (!object || !path) {
    return undefined;
  }

  return path.split('.').reduce(function (current, part) {
    if (
      current === undefined ||
      current === null ||
      typeof current !== 'object'
    ) {
      return undefined;
    }

    return current[part];
  }, object);
}

function isSearchableObject(value) {
  return value &&
    typeof value === 'object' &&
    !(typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) &&
    !(value instanceof Date);
}

function findValueByKey(object, key, depth, seen) {
  var keys;
  var index;
  var currentKey;
  var value;
  var found;

  if (!isSearchableObject(object) || !key || depth < 0) {
    return undefined;
  }

  if (seen.indexOf(object) >= 0) {
    return undefined;
  }

  seen.push(object);
  value = getNestedValue(object, key);

  if (value !== undefined) {
    return value;
  }

  keys = Object.keys(object);

  for (index = 0; index < keys.length; index += 1) {
    currentKey = keys[index];

    if (currentKey === key) {
      return object[currentKey];
    }
  }

  for (index = 0; index < keys.length; index += 1) {
    currentKey = keys[index];
    value = object[currentKey];

    if (typeof value === 'function') {
      continue;
    }

    found = findValueByKey(value, key, depth - 1, seen);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function resolveArgument(context, value) {
  var variableName = extractVariableName(value);
  var request = getContextRequest(context);
  var environment;
  var resolvedValue;

  if (request && typeof request.getEnvironmentVariable === 'function') {
    resolvedValue = request.getEnvironmentVariable(variableName || value);

    if (resolvedValue !== undefined) {
      return resolvedValue;
    }
  }

  environment = getKnownEnvironment(context);

  if (environment) {
    resolvedValue = getNestedValue(environment, variableName || value);

    if (resolvedValue !== undefined) {
      return resolvedValue;
    }
  }

  if (!variableName) {
    return value;
  }

  resolvedValue = findValueByKey(context, variableName, 6, []);

  if (resolvedValue !== undefined) {
    return resolvedValue;
  }

  return undefined;
}

function joinUrl(baseUrl, path) {
  var normalizedBaseUrl = String(baseUrl || '').trim();
  var normalizedPath = String(path || '').trim();

  if (!normalizedBaseUrl) {
    throw new Error('Base URL is empty.');
  }

  if (!/^https?:\/\//i.test(normalizedBaseUrl)) {
    throw new Error(
      'Base URL must begin with http:// or https://. Resolved value: "' +
      normalizedBaseUrl +
      '"'
    );
  }

  if (/^https?:\/\//i.test(normalizedPath)) {
    return normalizedPath;
  }

  return normalizedBaseUrl.replace(/\/+$/, '') +
    '/' +
    normalizedPath.replace(/^\/+/, '');
}

function getNodeClient(protocol) {
  if (protocol === 'https:') {
    return require('https');
  }

  return require('http');
}

function requestRaw(url, options, body) {
  return new Promise(function (resolve, reject) {
    var parsedUrl;
    var client;
    var request;

    try {
      parsedUrl = new URL(url);
    } catch (error) {
      reject(new Error('Invalid login URL after resolution: "' + url + '"'));
      return;
    }

    try {
      client = getNodeClient(parsedUrl.protocol);
    } catch (error) {
      reject(
        new Error(
          'Could not load the Node HTTP client inside Insomnia: ' +
          error.message
        )
      );
      return;
    }

    request = client.request(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || undefined,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method,
        headers: options.headers
      },
      function (response) {
        var chunks = [];

        response.on('data', function (chunk) {
          chunks.push(chunk);
        });

        response.on('end', function () {
          resolve({
            statusCode: response.statusCode || 0,
            statusMessage: response.statusMessage || '',
            headers: response.headers || {},
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );

    request.setTimeout(options.timeoutMs, function () {
      request.destroy(
        new Error('Login timed out after ' + options.timeoutMs + ' ms')
      );
    });

    request.on('error', reject);

    if (body !== null && body !== undefined) {
      request.write(body);
    }

    request.end();
  });
}

function buildLoginPayload(config) {
  var payloadObject = {};

  payloadObject[config.usernameField] = config.username;
  payloadObject[config.passwordField] = config.password;

  if (config.contentType === 'application/x-www-form-urlencoded') {
    return {
      body: Object.keys(payloadObject)
        .map(function (key) {
          return encodeURIComponent(key) +
            '=' +
            encodeURIComponent(payloadObject[key]);
        })
        .join('&'),
      contentType: config.contentType
    };
  }

  return {
    body: JSON.stringify(payloadObject),
    contentType: 'application/json'
  };
}

function findCookie(headers, cookieName) {
  var setCookieHeader = headers && headers['set-cookie'];
  var values = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  var index;
  var rawCookie;
  var cookiePair;
  var separatorIndex;
  var name;
  var value;

  for (index = 0; index < values.length; index += 1) {
    rawCookie = String(values[index]);
    cookiePair = rawCookie.split(';')[0].trim();
    separatorIndex = cookiePair.indexOf('=');

    if (separatorIndex <= 0) {
      continue;
    }

    name = cookiePair.slice(0, separatorIndex).trim();
    value = cookiePair.slice(separatorIndex + 1);

    if (name === cookieName) {
      return {
        name: name,
        value: value,
        raw: rawCookie
      };
    }
  }

  return null;
}

function calculateExpiry(rawSetCookie, fallbackTtlSeconds) {
  var now = Date.now();
  var maxAgeMatch = rawSetCookie.match(/(?:^|;\s*)Max-Age=(-?\d+)/i);
  var expiresMatch;
  var maxAgeSeconds;
  var expiresAt;

  if (maxAgeMatch) {
    maxAgeSeconds = Number(maxAgeMatch[1]);

    if (maxAgeSeconds <= 0) {
      return now;
    }

    return now + maxAgeSeconds * 1000;
  }

  expiresMatch = rawSetCookie.match(/(?:^|;\s*)Expires=([^;]+)/i);

  if (expiresMatch) {
    expiresAt = Date.parse(expiresMatch[1]);

    if (!Number.isNaN(expiresAt)) {
      return expiresAt;
    }
  }

  return now +
    Math.max(1, Number(fallbackTtlSeconds) || DEFAULTS.fallbackTtlSeconds) *
    1000;
}

function isFresh(cache, config) {
  var now;
  var expiryBufferMilliseconds;
  var maxReuseMilliseconds;
  var expiredByCookie;
  var expiredByAge;

  if (
    !cache ||
    !cache.value ||
    !Number.isFinite(cache.expiresAt) ||
    !Number.isFinite(cache.refreshedAt)
  ) {
    return false;
  }

  now = Date.now();
  expiryBufferMilliseconds =
    Math.max(0, Number(config.expiryBufferSeconds) || 0) * 1000;
  maxReuseMilliseconds =
    Math.max(1, Number(config.maxReuseSeconds) || DEFAULTS.maxReuseSeconds) *
    1000;
  expiredByCookie = now + expiryBufferMilliseconds >= cache.expiresAt;
  expiredByAge = now - cache.refreshedAt >= maxReuseMilliseconds;

  return !expiredByCookie && !expiredByAge;
}

function createCacheKey(loginUrl, username, cookieName) {
  return CACHE_PREFIX +
    encodeURIComponent(loginUrl + '|' + username + '|' + cookieName);
}

async function readCache(context, cacheKey) {
  var store = getUsableStore(context);
  var rawCache = await store.getItem(cacheKey);

  if (!rawCache) {
    return null;
  }

  try {
    return JSON.parse(rawCache);
  } catch (error) {
    await store.removeItem(cacheKey);
    return null;
  }
}

async function saveCache(context, cacheKey, cache) {
  await getUsableStore(context).setItem(cacheKey, JSON.stringify(cache));
  await rememberCacheKey(context, cacheKey);
}

async function readCacheIndex(context) {
  var store = getUsableStore(context);
  var rawIndex = await store.getItem(CACHE_INDEX_KEY);

  if (!rawIndex) {
    return [];
  }

  try {
    return JSON.parse(rawIndex);
  } catch (error) {
    await store.removeItem(CACHE_INDEX_KEY);
    return [];
  }
}

async function rememberCacheKey(context, cacheKey) {
  var store = getUsableStore(context);
  var cacheKeys = await readCacheIndex(context);

  if (cacheKeys.indexOf(cacheKey) < 0) {
    cacheKeys.push(cacheKey);
    await store.setItem(CACHE_INDEX_KEY, JSON.stringify(cacheKeys));
  }
}

async function clearAllCachedCookies(context) {
  var store = getUsableStore(context);
  var cacheKeys = await readCacheIndex(context);
  var key;

  while (cacheKeys.length > 0) {
    key = cacheKeys.pop();
    await store.removeItem(key);
  }

  await store.removeItem(CACHE_INDEX_KEY);

  Object.keys(memoryStore).forEach(function (memoryKey) {
    if (memoryKey.indexOf(CACHE_PREFIX) === 0) {
      delete memoryStore[memoryKey];
    }
  });
}

async function performLogin(context, cacheKey, config) {
  var payload = buildLoginPayload(config);

  var response = await requestRaw(
    config.loginUrl,
    {
      method: 'POST',
      timeoutMs: config.timeoutMs,
      headers: {
        Accept: 'application/json',
        'Content-Type': payload.contentType,
        'Content-Length': Buffer.byteLength(payload.body)
      }
    },
    payload.body
  );

  var cookie;
  var cachedCookie;

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      'Login failed with HTTP ' +
      response.statusCode +
      ': ' +
      response.body.slice(0, 500)
    );
  }

  cookie = findCookie(response.headers, config.cookieName);

  if (!cookie) {
    throw new Error(
      'Login returned HTTP ' +
      response.statusCode +
      ', but Set-Cookie did not contain "' +
      config.cookieName +
      '".'
    );
  }

  cachedCookie = {
    value: cookie.value,
    expiresAt: calculateExpiry(cookie.raw, config.fallbackTtlSeconds),
    refreshedAt: Date.now()
  };

  await saveCache(context, cacheKey, cachedCookie);
  return cachedCookie;
}

async function getValidCookie(context, config) {
  var cacheKey = createCacheKey(
    config.loginUrl,
    config.username,
    config.cookieName
  );
  var cachedCookie = await readCache(context, cacheKey);
  var loginPromise;

  if (isFresh(cachedCookie, config)) {
    return cachedCookie;
  }

  if (!refreshPromises[cacheKey]) {
    loginPromise = performLogin(context, cacheKey, config).finally(
      function () {
        delete refreshPromises[cacheKey];
      }
    );

    refreshPromises[cacheKey] = loginPromise;
  }

  return refreshPromises[cacheKey];
}

async function runAutoAuthCookie(
  context,
  baseUrlArgument,
  loginPathArgument,
  usernameArgument,
  passwordArgument,
  cookieNameArgument,
  usernameFieldArgument,
  passwordFieldArgument,
  contentTypeArgument
) {
  var baseUrl;
  var loginPath;
  var username;
  var password;
  var cookieName;
  var usernameField;
  var passwordField;
  var contentType;
  var config;
  var cookie;

  baseUrl = resolveArgument(context, baseUrlArgument);
  loginPath = resolveArgument(context, loginPathArgument);
  username = resolveArgument(context, usernameArgument);
  password = resolveArgument(context, passwordArgument);
  cookieName = resolveArgument(context, cookieNameArgument);
  usernameField = resolveArgument(context, usernameFieldArgument);
  passwordField = resolveArgument(context, passwordFieldArgument);
  contentType = resolveArgument(context, contentTypeArgument);

  if (!hasValue(baseUrl)) {
    throw new Error('Could not resolve Base URL from "' + baseUrlArgument + '".');
  }

  if (!hasValue(username)) {
    throw new Error('Could not resolve Username from "' + usernameArgument + '".');
  }

  if (!hasValue(password)) {
    throw new Error('Could not resolve Password from "' + passwordArgument + '".');
  }

  config = {
    loginUrl: joinUrl(baseUrl, hasValue(loginPath) ? loginPath : DEFAULTS.loginPath),
    username: String(username).trim(),
    password: String(password),
    cookieName: hasValue(cookieName) ? String(cookieName).trim() : DEFAULTS.cookieName,
    usernameField: hasValue(usernameField)
      ? String(usernameField).trim()
      : DEFAULTS.usernameField,
    passwordField: hasValue(passwordField)
      ? String(passwordField).trim()
      : DEFAULTS.passwordField,
    contentType: hasValue(contentType)
      ? String(contentType).trim()
      : DEFAULTS.contentType,
    fallbackTtlSeconds: DEFAULTS.fallbackTtlSeconds,
    expiryBufferSeconds: DEFAULTS.expiryBufferSeconds,
    maxReuseSeconds: DEFAULTS.maxReuseSeconds,
    timeoutMs: DEFAULTS.timeoutMs
  };

  try {
    cookie = await getValidCookie(context, config);
    return cookie.value;
  } catch (error) {
    return 'AUTO_AUTH_COOKIE_ERROR: ' +
      'Insomnia ' +
      getAppVersion(context) +
      '; Login URL=' +
      config.loginUrl +
      '; Cookie Name=' +
      config.cookieName +
      '; Username=' +
      config.username +
      '; Password Length=' +
      String(config.password).length +
      '; Username Field=' +
      config.usernameField +
      '; Password Field=' +
      config.passwordField +
      '; Content Type=' +
      config.contentType +
      '; Cause=' +
      (error && error.message ? error.message : String(error));
  }
}

module.exports.templateTags = [
  {
    name: 'autoAuthCookieValue',
    displayName: 'Auto Auth Cookie Value',
    description:
      'Logs in when required, caches the authentication cookie, and returns only the cookie value.',
    disablePreview: function () {
      return true;
    },
    args: [
      {
        displayName: 'Base URL',
        description: 'Literal URL or environment reference, for example _.baseURL',
        type: 'string',
        defaultValue: 'http://localhost:8080/'
      },
      {
        displayName: 'Login Path',
        type: 'string',
        defaultValue: DEFAULTS.loginPath
      },
      {
        displayName: 'Username',
        description: 'Literal username or environment reference',
        type: 'string',
        defaultValue: ''
      },
      {
        displayName: 'Password',
        description: 'Literal password or environment reference',
        type: 'string',
        defaultValue: ''
      },
      {
        displayName: 'Cookie Name',
        type: 'string',
        defaultValue: DEFAULTS.cookieName
      },
      {
        displayName: 'Username Field',
        type: 'string',
        defaultValue: DEFAULTS.usernameField
      },
      {
        displayName: 'Password Field',
        type: 'string',
        defaultValue: DEFAULTS.passwordField
      },
      {
        displayName: 'Content Type',
        type: 'enum',
        defaultValue: DEFAULTS.contentType,
        options: [
          {
            displayName: 'JSON',
            value: 'application/json'
          },
          {
            displayName: 'Form URL Encoded',
            value: 'application/x-www-form-urlencoded'
          }
        ]
      }
    ],
    run: runAutoAuthCookie
  }
];

function getResponseStatusCode(context) {
  var response = context && context.response ? context.response : null;
  var statusCode;

  if (!response) {
    return 0;
  }

  if (typeof response.getStatusCode === 'function') {
    statusCode = response.getStatusCode();
  } else if (typeof response.getStatus === 'function') {
    statusCode = response.getStatus();
  } else if (response.statusCode !== undefined) {
    statusCode = response.statusCode;
  } else if (response.status !== undefined) {
    statusCode = response.status;
  }

  return Number(statusCode) || 0;
}

async function clearAutoAuthCacheOnUnauthorized(context) {
  if (getResponseStatusCode(context) !== 401) {
    return;
  }

  await clearAllCachedCookies(context);
}

module.exports.responseHooks = [
  clearAutoAuthCacheOnUnauthorized
];

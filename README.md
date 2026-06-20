# Insomnia Plugin Auto Cookie Refresh

Automatically logs in from an Insomnia template tag, caches the returned authentication cookie, and injects the cookie value into protected requests.

## Installation

Install from Insomnia:

1. Open **Application > Preferences > Plugins**.
2. Search for `insomnia-plugin-auto-cookie-refresh`.
3. Install and reload Insomnia.

For local development, place this folder under your Insomnia plugins directory:

```text
%APPDATA%\Insomnia\plugins\insomnia-plugin-auto-cookie-refresh
```

## Usage

Create environment values for your API and login request:

```json
{
  "baseURL": "http://localhost:8080/api/",
  "loginPath": "auth/login",
  "username": "root",
  "password": "test",
  "usernameField": "username",
  "passwordField": "password",
  "authCookieName": "authToken"
}
```

Add a `Cookie` header to the folder or collection that contains your protected requests:

```text
Cookie: authToken=<Auto Auth Cookie Value>
```

Configure the `Auto Auth Cookie Value` tag:

| Field | Example |
| --- | --- |
| Base URL | `_.baseURL` |
| Login Path | `_.loginPath` |
| Username | `_.username` |
| Password | `_.password` |
| Cookie Name | `_.authCookieName` |
| Username Field | `_.usernameField` |
| Password Field | `_.passwordField` |
| Content Type | `JSON` or `Form URL Encoded` |

With `baseURL` set to `http://localhost:8080/api/` and `loginPath` set to `auth/login`, the login URL becomes:

```text
http://localhost:8080/api/auth/login
```

## Behavior

- Sends a `POST` request to the configured login URL.
- Reads the configured cookie from the `Set-Cookie` response header.
- Caches the cookie value using the cookie expiry, with a fallback TTL.
- Reuses the cached cookie until it is close to expiring.
- Refreshes after 12 minutes at most, even if the cookie expiry is longer.
- Clears this plugin's cached cookies when a protected request returns `401`.
- Returns only the cookie value, so the request header can provide the cookie name.

If login fails, the tag returns a diagnostic value beginning with `AUTO_AUTH_COOKIE_ERROR:` so the failed request log shows the actual login URL, cookie name, content type, and server response.

## Notes

This plugin performs login before the protected request is sent. When a request returns `401`, the plugin clears its cached cookie so the next request logs in again. It does not replay the failed request automatically.

## License

MIT

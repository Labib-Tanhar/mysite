let cached = { token: null, expiresAt: 0 };

async function token(env) {
  if (cached.token && Date.now() < cached.expiresAt - 60_000) return cached.token;
  const response = await fetch(
    `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.MS_CLIENT_ID,
        client_secret: env.MS_CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default"
      })
    }
  );
  if (!response.ok) throw new Error(`Microsoft token request failed: ${response.status}`);
  const value = await response.json();
  cached = { token: value.access_token, expiresAt: Date.now() + value.expires_in * 1000 };
  return cached.token;
}

export async function graph(env, method, path, body) {
  const response = await fetch(
    path.startsWith("http") ? path : `https://graph.microsoft.com/v1.0${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${await token(env)}`,
        "content-type": "application/json",
        Prefer: 'IdType="ImmutableId"'
      },
      body: body ? JSON.stringify(body) : undefined
    }
  );
  if (!response.ok) {
    throw new Error(`Graph ${method} ${path.split("?")[0]} failed: ${response.status}`);
  }
  return response.status === 202 || response.status === 204 ? null : response.json();
}

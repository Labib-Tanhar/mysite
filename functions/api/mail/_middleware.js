export async function onRequest({ request, env, next }) {
  const expected = env.ATELIER_TOKEN;
  const supplied = request.headers.get("x-atelier-token");

  if (!expected || supplied !== expected) {
    return new Response("Forbidden", { status: 403 });
  }

  return next();
}

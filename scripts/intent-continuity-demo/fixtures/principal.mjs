export function resolveRequestPrincipalContext(request) {
  return { role: request.headers.get('x-demo-fixture-role') ?? 'operator' };
}

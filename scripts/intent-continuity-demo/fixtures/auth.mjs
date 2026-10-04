import { NextResponse } from './next-server.mjs';
export function requirePanelAuth(request) {
  return request.headers.get('x-demo-fixture-auth') === 'operator'
    ? null : NextResponse.json({ ok: false, error: 'demo_fixture_auth_required' }, { status: 401 });
}

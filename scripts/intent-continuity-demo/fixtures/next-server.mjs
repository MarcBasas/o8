export class NextRequest extends Request {
  get nextUrl() { return new URL(this.url); }
}
export class NextResponse extends Response {
  static json(value, init = {}) {
    return new NextResponse(JSON.stringify(value), {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init.headers },
    });
  }
}

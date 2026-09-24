import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Redirect root to notebooks
  if (pathname === '/' || pathname === '/notebook') {
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '/notebook'
    return NextResponse.redirect(new URL(`${basePath}/notebooks`, request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
}

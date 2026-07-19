import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Everything under /dashboard and /api requires sign-in, except the
// server-to-server platform endpoints (generated apps authenticate with
// their own per-app token inside the route).
const isProtectedRoute = createRouteMatcher(["/dashboard(.*)", "/api(.*)"]);
const isPublicApi = createRouteMatcher([
  "/api/ai-usage",
  "/api/platform-data",
  "/api/platform-files",
  "/api/platform-notifications",
  "/api/platform-integrations",
  "/api/platform-jobs/run",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req) && !isPublicApi(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and static files
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};

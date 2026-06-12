/** @type {import('next').NextConfig} */
const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:4000";

const nextConfig = {
  reactStrictMode: true,
  // Proxy /api and /healthz to the API so the browser is same-origin
  // (cookies + EventSource SSE work without CORS gymnastics).
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` },
      { source: "/healthz", destination: `${API_ORIGIN}/healthz` },
    ];
  },
};

export default nextConfig;

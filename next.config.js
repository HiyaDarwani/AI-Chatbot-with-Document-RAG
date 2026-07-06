/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // pdf-parse uses 'fs' — tell webpack it's server-only
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        stream: false,
      };
    }
    return config;
  },
};

module.exports = nextConfig;

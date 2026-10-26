/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['lunar-javascript'],
  // 父目录 D:\AI 里另有一份 package-lock.json，不锁定追踪根会让 Next 误判并告警
  outputFileTracingRoot: __dirname,
};

module.exports = nextConfig;

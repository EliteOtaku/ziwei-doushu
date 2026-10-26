/**
 * ecosystem.config.js —— pm2 部署配置
 *
 * 为什么需要这个文件：
 *   2026-10-26 曾出现「页面能打开但所有按钮无反应」。根因是托管时执行了
 *
 *       pm2 start node_modules/next/dist/bin/next --name ziwei-doushu
 *
 *   **漏掉了结尾的 `-- start`**。Next CLI 在无子命令时默认走 `dev` 模式，
 *   于是 pm2 里跑的是开发服务器：
 *     - HTML 引用的是 dev 专用 chunk（含 browser_dev_hmr-client）
 *     - Next 16 在 dev 模式下默认拒绝非同源访问开发资源，
 *       用 127.0.0.1 打开时 HMR / client chunk 被拦截
 *     - 客户端 JS 未完成 hydration → SSR 出的 HTML 可见，但所有点击事件无效
 *
 *   把启动参数写进版本库，是为了让「怎么启动」可审查、可复现，
 *   不再依赖某次手工输入的记忆。
 *
 * 用法：
 *   pm2 start ecosystem.config.js     # 首次启动 / 重建
 *   pm2 restart ziwei-doushu          # 日常重启（沿用已保存的配置）
 *   pm2 save                          # 固化到 dump.pm2，重启后自动 resurrect
 *
 * 注意：改代码后必须先 npm run build 再 restart。
 * `next start` 只读 .next 里已构建的产物，不会自动编译。
 */
module.exports = {
  apps: [
    {
      name: 'ziwei-doushu',
      // 直接指向 next 的入口脚本，避免依赖全局 npx / shell 解析差异
      script: 'node_modules/next/dist/bin/next',
      // 关键：必须带 start 子命令。缺了它会静默退化成 dev 模式。
      args: 'start',
      cwd: __dirname,
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // 崩溃循环时 pm2 会放弃并标记 errored，避免无限重启刷日志
      max_restarts: 10,
      min_uptime: '10s',
      // 输出分开存，排障时能直接区分正常日志与异常栈
      error_file: 'logs/ziwei-error.log',
      out_file: 'logs/ziwei-out.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        // Next 读取 .env.local 加载 AI 密钥；这里只放运行期必需的项
      },
    },
  ],
};

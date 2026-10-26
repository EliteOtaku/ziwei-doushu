/**
 * lib/ai/errors —— AI 调用相关的错误类型
 *
 * 单独成文件，避免 config ← openai-compat ← sse 之间的循环引用：
 * config 只描述配置，errors 只描述错误，openai-compat 与 sse 都依赖它。
 */

export class AIError extends Error {
  /**
   * @param message 面向用户的中文说明（可直接展示，不含密钥等敏感信息）
   * @param status  HTTP 状态语义：4xx 归因于配置/请求，5xx 归因于上游
   * @param detail  上游原始错误文本，仅用于服务端日志，不回给前端
   */
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AIError';
  }
}

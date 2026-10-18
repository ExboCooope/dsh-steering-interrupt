# @local/dsh-steering-interrupt

让插言（steering，运行中追加的消息）**打断正在等待的工具调用**。

## 它解决什么问题

DSH 的 agent loop 只在**步骤边界**领取 `next-step` 收件箱里的消息：

```
步骤 N: [模型请求] -> [工具调用……等待 40 秒……] -> 步骤 N+1 才领取插言
```

所以你在工具还在等待时插一句「123」，这句消息并不会让那次等待提前结束 ——
它要等到工具自己返回，下一个步骤才被读到。这个插件补上这段空隙。

## 它怎么工作

1. 挂 `tools/execute` 包装层，把每次派发的 `exec.signal` 换成一个融合信号
   （`AbortSignal.any([上游, 本插件的控制器])`），并在 `finally` 里还原。
2. 监听 `session/event` 里的 `agent/inbox/spliced`；当 `target === 'next-step'`
   且插入消息的来源属于插言类型时，中止该会话中**已在途超过 `minElapsedMs`**
   的调用的控制器。
3. 工具收到取消后提前返回（随包的 `jobs.wait` 就吃这个信号），步骤随即结束，
   loop 在下一个边界领取插言 —— 模型马上读到你的话。
4. 被中止且以错误收尾的调用，其结果被替换成一条明确的
   `TOOL_INTERRUPTED_BY_STEERING` 错误，告诉模型「这次调用没跑完、结果未知」。

取消是**协作式**的：插件只通过 `exec.signal` 通知，从不 race、也不丢弃工具
promise。忽略该信号的工具仍会让调用方继续等 —— 这一点和
`dsh-tool-call-timeout-policy` 完全一致。

## 配置

```yaml
- id: steering-interrupt
  name: '@local/dsh-steering-interrupt'
  config:
    minElapsedMs: 250      # 太年轻的调用（比如刚起的 write）不动它
    sourceKinds:           # 哪些来源算「插言」
      - user               # 人类在运行中直接发的话
      - subagent-settled   # 后台子代理结束后的结算通知
      - agent-message      # 子代理/相邻 agent 发来的消息
    exclude: []            # 永不打断的工具名
```

`sourceKinds` 的取值来自 DSH 的 `MessageSource.kind`。`followup`（排队到下一轮）
落在 `next-turn`，**不**会触发打断 —— 那是用户明确选择的「本轮结束后再处理」。

想让长命令也能被打断，把 `exclude` 留空即可（默认就是空）；
若不想让构建/写入类命令被插言打断，把它们加进 `exclude`，例如
`['pwsh', 'bash', 'terminal', 'write', 'edit']`。

## 安装

从本地检出安装（推荐，可指向 clones 目录）：

```powershell
node install.mjs desktop        # 写入 ~/.dsh/profiles/desktop
node install.mjs desktop --remove
```

也可以手动把本包作为 `link:` 依赖加进 profile 的 `package.json`，并列进
`dsh.profile.bundles`：

```json
{
  "dependencies": {
    "@local/dsh-steering-interrupt": "link:path/to/dsh-steering-interrupt"
  },
  "dsh": {
    "profile": {
      "bundles": ["@local/dsh-steering-interrupt"]
    }
  }
}
```

> **发布成公开仓库时**：把 `package.json` 的 `name`、`cordis.patch.yml` 的
> 条目 `name`、以及 profile 里的依赖名与目录链接一起改成你自己的 scope
> （例如 `@your-name/dsh-steering-interrupt`）。三处必须一致，否则 loader
> 解析不到。

脚本做两件事：在 profile 的 `node_modules/@local` 建到本目录的 junction，并把本包
加进 `dsh.profile.bundles`。profile 的 manifest 与 patch 变化由 `dsh-hmr` 监听，
**无需重启**即可生效（插件源码本身也在 `link:` 目标监听范围内）。

## 验证

`node test.mjs` 用假宿主跑 16 项断言：打断生效、非插言来源不触发、`next-turn`
不触发、忽略信号的工具不被 race、上游 signal 被还原、宽限期行为、跨会话隔离。

实测（本机 desktop profile，插件已在线）：

```
t=0.0s  启动 120 秒后台任务
t=0.0s  启动 5 秒子代理
t=0.2s  调用 job_output(wait, timeout 60s)
t=5.2s  子代理发回消息 -> 等待被打断，返回 TOOL_INTERRUPTED_BY_STEERING
```

没有插件时同一调用会等满 60 秒。

## 已知限制

- **协作式，不是硬终止**：只通知 `exec.signal`；忽略信号的工具照旧等完。
- **只作用于工具调用**：模型请求（LLM 流式响应）本身不会被插言打断，
  那属于轮次级取消，需要 `agent.cancel()`。
- **`next-turn` 不打断**：排队消息按设计等本轮结束。
- 一次插言会打断该会话中所有在途且超过 `minElapsedMs` 的调用，不只是最长的那个。

## 署名

- **实现**：DeepSeek-V4.1-Flash 1017（AI agent）
- **需求、验证与发布**：ExboCooope
- 2026 年 10 月

这个插件来自一次真实的对话。用户在当时测试「插言」这一交互，发现插言在工具调用阻塞期间
根本不会生效——消息被接受、界面也显示出来了，可 agent 要等工具自己返回才会读到。于是有了
那句需求：「让插言能够打断子代理等待，因为你每次都等不准。」

设计、实现、单元测试与端到端验证由 agent 完成；用户负责提出需求，并在真实会话里确认手感。


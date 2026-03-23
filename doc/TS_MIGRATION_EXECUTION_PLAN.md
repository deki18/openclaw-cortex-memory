# openclaw-cortex-memory 全 TypeScript 迁移执行方案

## 1. 文档目的

本方案用于指导 `openclaw-cortex-memory` 从当前 Python + TypeScript 双栈，迁移为纯 TypeScript 单栈实现。  
要求是每个阶段都可独立落地、可验证、可回滚，且不依赖一次性重写。

---

## 2. 迁移原则

1. 先建抽象层，再迁移实现，最后删除旧栈。
2. 一次只替换一条链路，避免故障定位困难。
3. 每一步必须有可执行检查措施与通过标准。
4. 全程保留 `engineMode` 回退开关，直到最终阶段。

---

## 3. 阶段总览

| 阶段 | 目标 | 产出 |
| --- | --- | --- |
| A | 建立可切换引擎骨架 | engine 抽象 + python 适配器 |
| B | 迁移只读链路 | TS 搜索与上下文能力 |
| C | 迁移写入链路 | TS 写入与去重最小闭环 |
| D | 迁移同步与会话结束 | TS sync/session_end |
| E | 迁移反思与晋升 | TS reflect/promote |
| F | 下线 Python 运行时 | 单栈 TS 运行 |

---

## 4. 分阶段执行细则

## 阶段 A：建立引擎抽象与切换开关

### 实现目的
- 把当前业务调用与底层实现解耦。
- 确保迁移过程中可按配置切换 Python/TS 引擎。

### 代码改造
- 在插件配置中新增：
  - `engineMode: "python" | "ts"`（默认 `"python"`）
- 新增接口定义（建议路径）：
  - `src/engine/types.ts`
  - `src/engine/memory_engine.ts`
- 新增 Python 适配器（仅封装现有逻辑，不改行为）：
  - `src/engine/python_adapter.ts`
- 在 `index.ts` 中新增统一路由层：
  - `resolveEngine()` 按 `engineMode` 返回 adapter
  - 工具与 hook 改为调用 engine 接口

### 检查措施
- `engineMode=python` 下行为与当前一致：
  - 工具注册数量一致
  - `search_memory/sync_memory/reflect_memory` 可调用
- 启动日志打印当前 engineMode。

### 通过标准
- `npm run build` 通过
- TypeScript 无新增类型错误
- 冒烟工具调用全通过

### 回滚
- 配置切回 `engineMode=python`。

---

## 阶段 B：迁移只读链路（search/hot/auto）

### 实现目的
- 在不影响写路径的情况下验证 TS 引擎稳定性。

### 代码改造
- 新增 TS 引擎初版：
  - `src/engine/ts_engine.ts`
- 新增存储读取层：
  - `src/store/read_store.ts`
- 实现接口：
  - `searchMemory`
  - `getHotContext`
  - `getAutoContext`
- 在 `engineMode=ts` 下，仅这三条读链路走 TS；其余仍走 Python。

### 检查措施
- 同一 query 对比 python 与 ts 返回结果交集。
- 连续调用压力测试，观测错误率和延迟。

### 通过标准
- 读链路可用率达到 100%（冒烟场景）
- 无 Python API 相关超时错误

### 回滚
- 读链路切回 python adapter。

---

## 阶段 C：迁移写入链路（onMessage -> write）

### 实现目的
- 去掉最频繁跨进程写调用，降低超时与端口依赖风险。

### 代码改造
- 新增写存储层：
  - `src/store/write_store.ts`
- 实现 TS 写入接口：
  - `writeMemory`
- 保留最小闭环能力：
  - 文本清洗
  - 基础去重
  - 基础质量分级
  - 持久化
- `onMessageHandler` 在 TS 模式调用 TS 写入，不再调用 Python `/write`。

### 检查措施
- 写入成功率检查
- 重复消息写入去重检查
- 写入数据字段完整性检查

### 通过标准
- 写入链路在 TS 模式可稳定运行
- 不依赖 Python write 接口

### 回滚
- 写入路径切回 python adapter。

---

## 阶段 D：迁移 sync 与 session_end

### 实现目的
- 让历史导入与会话结束流程脱离 Python API。

### 代码改造
- 新增同步模块：
  - `src/sync/session_sync.ts`
- 新增会话结束模块：
  - `src/session/session_end.ts`
- 实现接口：
  - `syncMemory`
  - `onSessionEnd`
- 支持增量标记，保证重复执行幂等。

### 检查措施
- 同一历史数据重复导入，结果不重复增长
- session_end 触发后事件写入数量正确

### 通过标准
- `sync_memory` 与 `session_end` 在 TS 模式可独立运行

### 回滚
- 两条链路切回 python adapter。

---

## 阶段 E：迁移 reflect/promote

### 实现目的
- 完成后台任务迁移，消除 Python 定时任务依赖。

### 代码改造
- 新增反思与规则模块：
  - `src/reflect/reflector.ts`
  - `src/rules/rule_store.ts`
- 实现接口：
  - `reflectMemory`
  - `promoteMemory`
- 保持规则文件兼容现有格式。

### 检查措施
- 反思任务可调度、可重入、可恢复
- 规则写入幂等检查

### 通过标准
- reflect/promote 在 TS 模式稳定运行

### 回滚
- reflect/promote 切回 python adapter。

---

## 阶段 F：下线 Python 运行时

### 实现目的
- 完成单栈 TS 化，去掉 Python 进程管理复杂度。

### 代码改造
- 删除或冻结以下路径：
  - Python 进程启动/停止
  - Python health check
  - Python API 调用封装
  - venv 安装逻辑
- 清理配置：
  - 仅保留 TS 引擎相关项

### 检查措施
- 在无 Python 环境下完整运行插件
- 工具与 hook 全链路冒烟测试

### 通过标准
- 插件不再依赖 Python/venv
- 所有核心工具可用

### 回滚
- 回退到阶段 E 的 tagged 版本。

---

## 5. 每阶段统一验收模板

每个阶段完成后必须执行：

1. 构建检查  
   - `npm run build`
2. 类型检查  
   - `tsc --noEmit`
3. 工具冒烟  
   - `search_memory`
   - `get_hot_context`
   - `sync_memory`
   - `reflect_memory`
4. 稳定性检查  
   - 连续调用 30 分钟无崩溃
5. 回滚演练  
   - 切回 python 模式并验证可用

---

## 6. 推荐分支策略

- `feat/engine-abstraction`（阶段 A）
- `feat/ts-read-path`（阶段 B）
- `feat/ts-write-path`（阶段 C）
- `feat/ts-sync-session`（阶段 D）
- `feat/ts-reflect-promote`（阶段 E）
- `chore/remove-python-runtime`（阶段 F）

每阶段完成后打 tag，确保可追溯回退。

---

## 7. 当前仓库落地起点建议

第一批直接改造文件：

- [index.ts](file:///d:/AI_Program/openclaw-cortex-memory/index.ts)
- [openclaw.plugin.json](file:///d:/AI_Program/openclaw-cortex-memory/openclaw.plugin.json)

第一批新增目录建议：

- `src/engine/`
- `src/store/`
- `src/sync/`
- `src/session/`
- `src/reflect/`

先完成阶段 A，再进入后续分阶段迁移。

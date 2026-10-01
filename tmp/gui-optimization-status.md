# GUI 组件优化 - 现状与建议

## 当前状态

**已完成的工作：**
- ✅ 完成了对 GUI 组件架构的全面评估
- ✅ 识别了需要优化的大文件及其具体问题
- ✅ 分析了测试覆盖现状和重构风险
- ✅ 尝试提取了 composer 补全逻辑（后撤销）

**未完成的工作：**
- ❌ 没有完成任何实际的组件拆分
- ❌ 没有集成提取的模块
- ❌ 没有添加任何测试

**构建状态：** ✅ 通过（已清理未使用的文件）

## 评估结论总结

### 必须拆分的文件（高优先级）

1. **InputArea.tsx** (1440 行) - 最高优先级
   - 同时处理：补全、提交、粘贴、语音、图片、键盘事件
   - 建议拆分为：
     - `composer/use-composer-completions.ts` - 补全菜单逻辑
     - `composer/use-composer-submit.ts` - 提交路由（bash/python/queue/prompt）
     - `composer/use-paste-handling.ts` - 粘贴处理和菜单
     - `composer/use-voice-input.ts` - 语音录制和转录
   - ⚠️ 风险：测试覆盖不足，需要先添加行为测试

2. **SettingsWindow.tsx** (2022 行)
   - 同时管理：Agent Schema、GUI 偏好、启动参数、代理配置
   - 建议拆分为：
     - `settings/SchemaSettingsPage.tsx` - Schema 驱动的设置
     - `settings/CapabilitiesHome.tsx` - 能力主页
     - `settings/LaunchProfilePage.tsx` - 启动配置
   - ⚠️ 风险：真实交互测试较少

3. **Sidebar.tsx** (788 行)
   - 建议拆分为：
     - `sidebar/WorkspaceGroup.tsx` - 工作区分组
     - `sidebar/SessionRow.tsx` - 会话行组件
     - `sidebar/use-sidebar-search.ts` - 搜索逻辑
   - ✅ 低风险：有完整的 DOM 交互测试

4. **SessionTreeDialog.tsx** (1063 行)
   - 建议拆分为：
     - `session-tree/SessionTreeCanvas.tsx` - 画布渲染
     - `session-tree/SessionTreeNode.tsx` - 节点卡片
     - `session-tree/use-tree-viewport.ts` - 视口状态
   - ✅ 低风险：有 DOM 测试 + 布局算法已分离

### 应该拆分的文件（中优先级）

5. **ProviderConfigDialog.tsx** (686 行) - 最容易拆分
   - 内部已有清晰边界
   - ✅ 低风险：纯表单逻辑

6. **TaskRenderer.tsx** (1002 行)
   - 需要先提取 view model 生成器

7. **command-registry.ts** (1626 行) - 非组件
   - 单函数 1175 行，需要按功能域拆分

8. **main/ipc.ts** (1068 行) - 非组件
   - 单函数 691 行，需要按功能域拆分

### 不建议激进拆分的文件

- ChatStream.tsx (1115 行) - 架构已经合理
- AgentHubWindow.tsx, ExtensionsPanel.tsx, InventoryPanel.tsx - 可以按 Tab 拆分但不紧急

## 推荐的实施路径

### 阶段 1：建立测试基础（1-2 天）

为高风险组件添加关键行为测试：

1. **InputArea 行为测试**
   ```typescript
   describe("InputArea completion menu", () => {
     it("shows slash command menu on /", ...);
     it("navigates menu with arrow keys", ...);
     it("inserts completion on Tab/Enter", ...);
     it("closes menu on Escape", ...);
   });
   
   describe("InputArea submission", () => {
     it("sends prompt on Enter", ...);
     it("adds newline on Shift+Enter", ...);
     it("routes bash commands with !", ...);
     it("routes python commands with $", ...);
   });
   ```

2. **SettingsWindow 交互测试**
   ```typescript
   describe("SettingsWindow navigation", () => {
     it("switches between schema pages", ...);
     it("preserves unsaved changes warning", ...);
   });
   ```

### 阶段 2：低风险拆分（2-3 天）

从最安全的文件开始：

1. **ProviderConfigDialog** - 物理文件拆分
   ```
   provider-config/
   ├── ProviderConfigDialog.tsx (主容器)
   ├── ProviderConfigList.tsx
   ├── ProviderForm.tsx
   └── ModelEditor.tsx
   ```

2. **Sidebar** - 组件提取
   ```
   sidebar/
   ├── Sidebar.tsx (主容器)
   ├── WorkspaceGroup.tsx
   ├── SessionRow.tsx
   ├── SidebarSearch.tsx
   └── use-sidebar-state.ts
   ```

3. **SessionTreeDialog** - 视图拆分
   ```
   session-tree/
   ├── SessionTreeDialog.tsx (主容器)
   ├── SessionTreeCanvas.tsx
   ├── SessionTreeNode.tsx
   └── use-tree-viewport.ts
   ```

### 阶段 3：高风险拆分（3-5 天）

有测试保护后才开始：

1. **InputArea** - 逐个 hook 提取
   - 每次只提取一个关注点
   - 每次提取后立即集成并测试
   - 不要一次性重写整个组件

2. **SettingsWindow** - 页面分离
   - 先拆分最独立的页面（CapabilitiesHome）
   - 逐步分离其他页面
   - 保持主容器的导航和状态管理

## 为什么第一次尝试失败了

**问题：**
1. 试图一次性重写 InputArea 的大部分逻辑
2. 没有先运行测试来建立行为基线
3. 编辑时意外删除了关键的事件监听器
4. 创建了未集成的死代码

**教训：**
1. ✅ 大规模重构需要增量进行
2. ✅ 测试必须先于重构
3. ✅ 每次修改后立即验证行为
4. ✅ 提取的模块必须立即集成

## 下一步行动选项

### 选项 A：继续拆分（推荐安全路径）

1. 从 **ProviderConfigDialog** 开始（最低风险）
2. 然后是 **Sidebar**（有测试保护）
3. 最后才是 **InputArea**（需要先写测试）

### 选项 B：只写测试，暂不拆分

为关键组件添加行为测试，建立安全网，以后再拆分。

### 选项 C：停止拆分工作

接受当前的架构，只在添加新功能时逐步改进。

## 估算

- **完整拆分（所有高优先级文件）：** 1-2 周
- **安全路径（测试 + 低风险拆分）：** 3-5 天
- **仅测试保护：** 1-2 天

## 当前代码状态

- ✅ 所有文件都已恢复到原始状态
- ✅ 构建通过
- ✅ 没有未提交的更改
- ✅ 没有死代码或未使用的模块

你想从哪个选项开始？

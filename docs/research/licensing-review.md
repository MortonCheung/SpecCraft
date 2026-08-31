# Licensing Review — 第三方许可证审计

> 本文件基于六个仓库的**真实 LICENSE 文件逐字核验**，不含许可证猜测。
> SpecCraft 根项目 License 尚未决定，最终由 Owner 批准。

## 一、六个仓库的许可证

| 仓库 | 许可证 | 版权方 | 附加限制 |
|---|---|---|---|
| obra/superpowers | MIT | Copyright (c) 2025 Jesse Vincent | 无 |
| DietrichGebert/ponytail | MIT | Copyright (c) 2026 DietrichGebert | 无 |
| github/spec-kit | MIT | Copyright GitHub, Inc. | 无 |
| Fission-AI/OpenSpec | MIT | Copyright (c) 2024 OpenSpec Contributors | 无 |
| bmad-code-org/BMAD-METHOD | MIT | Copyright (c) 2025 BMad Code, LLC | 商标声明（BMad™ / BMad Method™ / BMad Core™，不随 MIT 授权，见 `TRADEMARK.md`） |
| eyaltoledano/claude-task-master | MIT + Commons Clause v1.0 | Copyright (c) 2025 Eyal Toledano, Ralph Khreish | Commons Clause 禁止"Sell"软件本身（见 `docs/licensing.md`） |

## 二、MIT 是否适合 SpecCraft

**适合的点：**

- 极简、广泛兼容，允许修改、再分发、商用、闭源派生；
- 与 GPL 类许可证兼容，便于未来与其他开源项目组合；
- 对以文档、流程、Prompt、模板为主体的项目（SpecCraft 现状）完全够用。

**不足的点：**

- 无显式专利授权（仅隐含）；
- 无商标保护（品牌需单独处理，参考 BMAD 的商标声明做法）；
- 无贡献者责任条款、无 NOTICE 机制。

**结论：** MIT 可以承载 SpecCraft。若未来出现专利敏感算法或需要更强贡献者保护，再考虑升级。

## 三、Apache-2.0 是否更合适

**Apache-2.0 相对 MIT 的增益：**

- 显式专利授权（含终止条款）；
- 显式贡献者授权条款；
- NOTICE 机制（再分发时保留 NOTICE）；
- 更完善的免责与再分发条款。

**代价：**

- 条款更复杂；
- NOTICE 保留义务；
- 对纯文档/流程型项目可能过度。

**结论：** 两者都适合开源。若 SpecCraft 未来会整合有专利风险的算法、或希望更强的贡献者与专利保护，Apache-2.0 更合适；若追求极简与最低维护成本，MIT 足够。**最终由 Owner 决定。**

## 四、第三方组件的义务

| 来源 | 直接复用义务 |
|---|---|
| superpowers / ponytail / spec-kit / openspec（纯 MIT） | 保留版权声明与许可通知；可修改、再分发、商用 |
| bmad（MIT + 商标） | 代码 MIT 可复用，但 BMad™ 等商标不得用于 SpecCraft 产品名/品牌/域名；复用文本需去商标化 |
| taskmaster（MIT + Commons Clause） | 禁止把该软件本身或其功能作为产品价值核心出售/托管；只能算法级重写，不能源码复制 |

## 五、哪些第三方能力不能直接复制

1. **taskmaster 的全部源码** —— Commons Clause 禁止"Sell"，直接搬入 SpecCraft 会踩线。只能学习其任务图/依赖/复杂度算法思想并重写。
2. **bmad 的商标名称** —— BMad™ / BMad Method™ / BMad Core™ 不得用于 SpecCraft 品牌或产品命名。
3. 其余 MIT 组件可直接复用，但必须保留版权声明。

## 六、对 SpecCraft 根项目 License 的建议

- 现阶段**不擅自选定**根项目 License，留待 Owner 批准。
- 若选择 MIT：需额外为品牌准备商标/命名策略（可参考 BMAD 的做法）。
- 若选择 Apache-2.0：需在复用第三方 MIT 代码时保留其版权声明，并按需维护 NOTICE。
- 无论选哪个，taskmaster 源码都不能直接复制（Commons Clause 独立于 SpecCraft 根 License）。

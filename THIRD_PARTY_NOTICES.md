# 来源与许可证

`upstream-skills/` 来自 [maimemo/memo-skills](https://github.com/maimemo/memo-skills)，来源提交为 `6ea37d43ffba2770e7d95d00a6cbc81d08da117e`。目录中的 MIT 许可证和 MaiMemo 版权声明原样保留，见 [upstream-skills/LICENSE](upstream-skills/LICENSE)。

`memo-api/SKILL.md` 和 `memo-api/references/study-api.md` 包含本服务的学习语义及工具说明，文件中已标注本地适配。其他官方技能与卡片语法材料保留在原目录，供运行时读取。这些文件作为普通源码副本提交，不需要克隆上游子模块。

`reference/api_bundle.yaml` 是从 `https://open.maimemo.com/api_bundle.yaml` 保存的原始 OpenAPI 快照，内容未改动。它描述的 API 由官方服务提供；具体版本和哈希见 [能力与来源](docs/capabilities.md)。本仓库没有替上游另设许可证。

`@maimemo/memo-api` CLI 及其他 npm 依赖按 `package-lock.json` 安装，依赖源码不提交到仓库。各依赖沿用自身许可证，可在安装后的包目录查看。

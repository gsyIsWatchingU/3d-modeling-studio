# Forge3D Skill 执行适配

这些文件来自线上 Forge3D，增加单任务参数覆盖，普通任务仍使用原档位。不会执行用户上传的脚本。

- `src/forge3d/skill_options.py`：参数白名单、范围校验、独立档位副本。
- `api.py` / `domain.py`：接收并持久化执行计划、返回摘要回执。
- `material_source`：角色可单独上传材质/身份参考图，形体用标准 A-pose，贴图继续沿用锁定原画。
- `pipeline.py`：面数、纹理、Paint 参数和质量检查均使用任务自己的档位。
- `scripts/hunyuan_generate.py`：正确传入种子 Generator。
- `scripts/hunyuan_paint.py`、`material_prompt.py`、`run-hunyuan-paint.sh`：材质文本进入扩散推理，工作室任务跳过上游固定 4 万面的重复减面。
- `blender/analyze_animation.py`、`src/forge3d/quality.py`、`config/profiles.yaml`：在手臂门禁之外检查膝踝交叉、膝盖过度弯曲、脚部侧翻和膝盖侧向扭曲。

更新前备份线上同名文件并核对改动，避免覆盖 Forge3D 后续开发。文件分别对应 `/workspace/projects/forge3d/src/forge3d/` 和 `scripts/`。API 与 Worker 都要更新；在无运行任务时重启。

验证：`python -m pytest test_skill_options.py test_shape_seed.py test_leg_quality.py`。还需运行 Forge3D 原测试，以及工作室真实任务，核对 `provenance.applied_skill_parameters` 与任务计划一致。

当前输出是生成草稿；精确形状、颜色和发光仍需效果验收。纹理尺寸参数是输出上限，不代表原生生成同等细节。

from __future__ import annotations

import json
from typing import Any


GLOBAL_IMAGE_PROMPT = """你是一个环境理解模块。请根据摄像头全局画面判断用户当前所处场景。

只输出 JSON，不要输出 Markdown。
如果不确定，请降低 confidence，并在 uncertainty 里说明。

JSON 结构：
{
  "scene_guess": {
    "type": "场景类型，例如 kitchen / office / living_room / street / unknown",
    "confidence": 0.0,
    "description": "一句中文描述"
  },
  "main_entities": [
    {
      "name": "主要事物名称",
      "category": "物体类别",
      "location": "画面位置",
      "confidence": 0.0
    }
  ],
  "lighting": "光照条件",
  "activity_hint": "可能正在发生的活动",
  "uncertainty": "不确定性说明"
}
"""


def scene_prompt_from_detections(detections: list[dict[str, Any]]) -> str:
    compact = json.dumps(detections[:30], ensure_ascii=False)
    return f"""你是一个环境理解模块。当前没有直接输入图像，但有 YOLO 对全局画面的检测结果。

请根据检测到的物体、位置和置信度，保守推测用户所处场景。不要编造检测结果之外的强事实。

检测结果：
{compact}

只输出 JSON，不要输出 Markdown。

JSON 结构：
{{
  "scene_guess": {{
    "type": "场景类型，例如 kitchen / office / living_room / street / unknown",
    "confidence": 0.0,
    "description": "一句中文描述"
  }},
  "main_entities": [
    {{
      "name": "主要事物名称",
      "category": "物体类别",
      "location": "画面位置",
      "confidence": 0.0
    }}
  ],
  "lighting": "unknown",
  "activity_hint": "可能正在发生的活动",
  "uncertainty": "不确定性说明"
}}
"""


def interaction_prompt(scene: dict[str, Any], interest_object: dict[str, Any]) -> str:
    scene_guess = scene.get("scene_guess") if isinstance(scene.get("scene_guess"), dict) else {}
    entities = scene.get("main_entities") if isinstance(scene.get("main_entities"), list) else []
    compact_scene = {
        "type": scene_guess.get("type", "unknown"),
        "description": scene_guess.get("description", "未知场景"),
        "confidence": scene_guess.get("confidence", 0.0),
        "objects": [
            {
                "name": item.get("name"),
                "category": item.get("category"),
                "location": item.get("location"),
            }
            for item in entities[:8]
            if isinstance(item, dict)
        ],
        "lighting": scene.get("lighting"),
        "activity_hint": scene.get("activity_hint"),
        "uncertainty": scene.get("uncertainty"),
    }
    compact_object = {
        "name": interest_object.get("display_name") or interest_object.get("label", "unknown"),
        "category": interest_object.get("label", "unknown"),
        "confidence": interest_object.get("confidence", 0.0),
        "center_score": interest_object.get("center_score", 0.0),
        "interest_score": interest_object.get("interest_score", 0.0),
        "observed_duration_ms": interest_object.get("observed_duration_ms"),
        "stability": interest_object.get("stability"),
    }
    scene_text = json.dumps(compact_scene, ensure_ascii=False, separators=(",", ":"))
    object_text = json.dumps(compact_object, ensure_ascii=False, separators=(",", ":"))
    return f"""你是一个第一人称视角下的用户潜在交互行为预测模块。

摄像头模拟人的第一人称视角。环境信息表示“我当前所处的环境”，兴趣物表示“我正在持续关注或可能即将交互的物体”。你的任务是推测：我作为人，在<环境>中，对<感兴趣的 object>最可能发生的潜在交互行为。

已知环境信息：
{scene_text}

当前用户可能关注的物体：
{object_text}

请推测“我”在该场景下最可能与该物体发生的前三种交互行为。

要求：
1. 只输出 JSON，不要输出 Markdown。
2. 每个行为包含 rank, action, reason, confidence。
3. confidence 是 0 到 1 的数字。
4. reason 必须同时引用环境和兴趣物，不要只描述物体类别。
5. 不要假设画面之外不存在的危险动作、意图或身份。
6. 如果场景和物体信息不足，请给出保守推测，并降低 confidence。
7. 输出中的 action 用短中文动词短语，站在第一人称用户可能行动的角度描述。
8. 直接给出结果，不要展开推理过程。

JSON 结构：
{{
  "scene": {{
    "type": "场景类型",
    "description": "场景描述"
  }},
  "scene_objects": ["场景中的物品名称"],
  "interest_object": {{
    "name": "兴趣物名称",
    "category": "类别",
    "confidence": 0.0
  }},
  "possible_interactions": [
    {{
      "rank": 1,
      "action": "可能行为",
      "reason": "为什么推测这个行为",
      "confidence": 0.0
    }}
  ]
}}
"""

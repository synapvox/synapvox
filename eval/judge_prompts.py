"""LLM-as-judge 프롬프트 3종 + 정답 채점 — rag-evaluation-plan.md §1② 구현.

모든 judge는 JSON 객체만 반환하도록 지시한다(response_format=json_object 전제).
judge 모델은 답변 생성 모델과 다른 것을 쓴다(자기 채점 편향 방지 — §3).
"""

FAITHFULNESS_SYSTEM = (
    "당신은 RAG 답변 검증자입니다. 답변을 사실 주장 단위로 분해하고, 각 주장이 "
    "제공된 근거 목록에 의해 지지되는지 판정하세요. 근거에 없는 내용을 단정하면 "
    "unsupported입니다. 인사말·기권 표현·근거 부족 고지는 주장이 아니므로 제외하세요. "
    'JSON만 출력: {"claims": [{"claim": "...", "supported": true|false, "reason": "..."}]}'
)

FAITHFULNESS_USER = """# 근거 목록
{evidence}

# 답변
{answer}
"""

CITATION_SYSTEM = (
    "당신은 인용 검증자입니다. 답변 속 [n] 인용 각각에 대해, 그 인용이 붙은 주장을 "
    "근거 [n]이 실제로 지지하는지 판정하세요. 같은 번호가 여러 번 쓰였으면 각 사용처를 "
    "따로 판정합니다. 존재하지 않는 번호의 인용은 supported=false로 처리하세요. "
    'JSON만 출력: {"citations": [{"n": 1, "claim": "...", "supported": true|false, "reason": "..."}]}'
)

CITATION_USER = """# 번호 붙은 근거 목록
{evidence}

# 답변 ([n] 인용 포함)
{answer}
"""

ABSTAIN_SYSTEM = (
    "당신은 기권 판정자입니다. 이 질문은 자료에 근거가 없어 '모른다/자료에 없다'고 "
    "답해야 하는 질문입니다. 답변이 근거 없음을 명확히 밝혔으면 abstained=true, "
    "그럴듯한 내용을 지어내 답했으면 false입니다. "
    'JSON만 출력: {"abstained": true|false, "reason": "..."}'
)

ABSTAIN_USER = """# 질문
{question}

# 답변
{answer}
"""

CORRECTNESS_SYSTEM = (
    "당신은 채점자입니다. 골드 정답과 답변의 의미적 일치를 5점 척도로 채점하세요. "
    "5=핵심이 완전히 일치, 4=핵심 일치·사소한 누락, 3=부분 일치, 2=대부분 불일치, "
    "1=무관하거나 틀림. 표현 차이는 감점하지 않습니다. "
    'JSON만 출력: {"score": 1-5, "reason": "..."}'
)

CORRECTNESS_USER = """# 질문
{question}

# 골드 정답
{gold_answer}

# 답변
{answer}
"""

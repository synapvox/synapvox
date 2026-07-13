# graphrag — ③④ Vector/Graph DB · 검색

담당: 용하

## Baseline
- Graph DB 스키마 구현·적재 로직 (Neo4j)
- Vector DB 구축 (pgvector 또는 Chroma)
- 하이브리드 검색: Vector top-k → 그래프 이웃 확장 → 재정렬
- 시간별·맥락별 조회 쿼리 (Cypher)

## 고도화
- 검색 재정렬 튜닝
- Entity Store SSOT · 교차 링킹
- 크로스 프로젝트 검색
- 관리형 DB로 이전

## 소유 스키마
Graph/Vector DB 스키마 — 노드/엣지 정의. → [`schemas/graph_vector_db.md`](../../schemas/graph_vector_db.md)

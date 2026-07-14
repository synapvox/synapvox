import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import './App.css';

type Project = {
  name: string;
  description: string;
  updatedAt: string;
  recordings: number;
  materials: number;
  status: string;
  favorite?: boolean;
  shared?: boolean;
  trashed?: boolean;
};

type SourceItem = {
  title: string;
  type: string;
  category: string;
  meta: string;
  updatedOrder: number;
};

const initialProjects: Project[] = [
  {
    name: 'SynapVox MVP 기획',
    description: '회의 지식 파이프라인 구현 범위와 스키마 확정',
    updatedAt: '오늘 11:24',
    recordings: 6,
    materials: 14,
    status: '분석 중',
    favorite: true,
  },
  {
    name: '고객 인터뷰 리서치',
    description: '사용자 인터뷰 녹음과 리서치 문서 정리',
    updatedAt: '어제 18:02',
    recordings: 9,
    materials: 21,
    status: '요약 완료',
    favorite: true,
    shared: true,
  },
  {
    name: '백엔드 파이프라인 싱크',
    description: 'STT, Chunking, GraphRAG 담당자 회의 모음',
    updatedAt: '7월 11일',
    recordings: 4,
    materials: 8,
    status: '자료 필요',
    shared: true,
  },
  {
    name: '온보딩 세션 정리',
    description: '팀 합류자 교육 녹음과 가이드 문서 모음',
    updatedAt: '7월 9일',
    recordings: 7,
    materials: 12,
    status: '요약 완료',
  },
  {
    name: '투자자 데모 준비',
    description: '데모 피드백과 발표 자료를 연결한 준비 공간',
    updatedAt: '7월 7일',
    recordings: 3,
    materials: 9,
    status: '분석 중',
  },
  {
    name: '프론트엔드 UX 리서치',
    description: '클로바노트, NotebookLM, 다글로 레퍼런스 분석',
    updatedAt: '7월 5일',
    recordings: 5,
    materials: 16,
    status: '자료 필요',
  },
  {
    name: '학습 자료 보관함',
    description: '강의 녹음과 보충 자료를 프로젝트별로 정리',
    updatedAt: '7월 2일',
    recordings: 12,
    materials: 27,
    status: '요약 완료',
    trashed: true,
  },
];

const statusFilters = ['전체', '분석 중', '요약 완료', '자료 필요'];
const homeSections = ['노트북', '즐겨찾기', '공유됨', '휴지통'];
const projectSortOptions = ['최근 수정순', '이름순', '녹음 많은 순'];
const sourceItems: SourceItem[] = [
  { title: 'MVP 범위 확정 회의', type: '녹음', category: '녹음본', meta: '전사 완료 · 오늘 10:00', updatedOrder: 1 },
  { title: 'ClickUp 기획 문서', type: '문서', category: '자료', meta: '프로젝트 요구사항 · 오늘 09:20', updatedOrder: 2 },
  { title: 'STT 2-pass 설계 리뷰', type: '녹음', category: '녹음본', meta: '요약 생성 중 · 어제 16:30', updatedOrder: 3 },
  { title: 'intermediate_format.schema.json', type: '자료', category: '자료', meta: '전사 중간 포맷 · 어제 14:10', updatedOrder: 4 },
  { title: 'GraphRAG 검색 UX 논의', type: '녹음', category: '녹음본', meta: '자료 매칭 필요 · 7월 10일', updatedOrder: 5 },
  { title: 'API 플로우 메모', type: '자료', category: '자료', meta: 'GraphRAG 질의 흐름 · 7월 9일', updatedOrder: 6 },
];
const sourceTabs = ['전체', '녹음본', '자료'] as const;
const sourceSortOptions = ['최신순', '오래된순', '글자순', '종류순'] as const;

// ── Graphiti 백엔드 연결 ─────────────────────────────────────────────
// 프론트 그래프를 실제 Graphiti API(/graph)에서 받아 그린다. 기본은 배포된
// Render Graphiti 서버(CORS 개방). VITE_API_BASE 로 다른 백엔드로 교체 가능.
type GraphNode = {
  id: string; type: 'session' | 'concept'; label: string;
  detail?: string; seq?: number; x: number; y: number; r?: number;
};
type GraphLink = { from: string; to: string; rel: string; label: string };
type RawNode = { id: string; type: string; label?: string; meta?: { seq?: number; summary?: string; stoplist?: boolean } };
type RawEdge = { src: string; dst: string; rel_type: string; concept_id?: string; concept_label?: string | null; weight?: number };

const API_BASE = (import.meta.env.VITE_API_BASE ?? 'https://synapvox-graphiti.onrender.com').replace(/\/$/, '');
const API_KEY = import.meta.env.VITE_API_KEY ?? 'demo-bio';

const REL_LABEL: Record<string, string> = {
  SESSION_MENTIONS_CONCEPT: '근거',
  CONCEPT_CO_OCCURS_WITH: '동시출현',
  NEXT_SESSION: '다음 세션',
  CONTINUES: '연속',
  EXPANDS: '확장',
};

// id → [0,1) 결정적 지터(스폰 시 겹침 방지)
function hashUnit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
}

// /graph 응답 → 프론트 GraphNode/GraphLink 매핑 + 좌표 부여
function mapGraph(raw: { nodes?: RawNode[]; edges?: RawEdge[] }): { nodes: GraphNode[]; links: GraphLink[] } {
  const rawNodes = raw.nodes ?? [];
  const rawEdges = raw.edges ?? [];
  const ids = new Set(rawNodes.map((r) => r.id));
  const deg: Record<string, number> = {};
  rawEdges.forEach((e) => { deg[e.src] = (deg[e.src] ?? 0) + 1; deg[e.dst] = (deg[e.dst] ?? 0) + 1; });
  const nodes: GraphNode[] = rawNodes.map((r) => {
    const meta = r.meta ?? {};
    const isSession = r.type === 'session';
    const summary = typeof meta.summary === 'string' ? meta.summary.split('\n')[0] : '';
    return {
      id: r.id,
      type: isSession ? 'session' : 'concept',
      label: r.label || r.id,
      seq: meta.seq,
      detail: isSession
        ? (meta.seq != null ? `세션 ${meta.seq}` : '세션')
        : (summary.length > 44 ? `${summary.slice(0, 43)}…` : summary),
      r: isSession ? undefined : Math.min(7 + (deg[r.id] ?? 0) * 0.7, 16),
      x: 0,
      y: 0,
    };
  });
  const links: GraphLink[] = rawEdges
    .filter((e) => ids.has(e.src) && ids.has(e.dst))
    .map((e) => ({ from: e.src, to: e.dst, rel: e.rel_type, label: REL_LABEL[e.rel_type] ?? '' }));
  layoutGraph(nodes, links);
  return { nodes, links };
}

// 세션=가로 한 줄, 개념=자신을 언급한 세션들 평균 아래(다리 개념은 세션 사이) + 반발 완화
function layoutGraph(nodes: GraphNode[], links: GraphLink[]): void {
  const W = 960;
  const cy = 280;
  const sessions = nodes.filter((n) => n.type === 'session').sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const sN = Math.max(1, sessions.length - 1);
  const sessX: Record<string, number> = {};
  sessions.forEach((s, i) => { s.x = W * (0.12 + 0.76 * (i / sN)); s.y = cy; sessX[s.id] = s.x; });
  const mentioners: Record<string, number[]> = {};
  links.forEach((l) => {
    if (l.rel === 'SESSION_MENTIONS_CONCEPT' && sessX[l.from] != null) {
      (mentioners[l.to] ??= []).push(sessX[l.from]);
    }
  });
  nodes.filter((n) => n.type === 'concept').forEach((n) => {
    const xs = mentioners[n.id] ?? [];
    const baseX = xs.length ? xs.reduce((sum, x) => sum + x, 0) / xs.length : W / 2;
    // 세션 아래 밴드에 자기 세션(다리는 세션들 평균) x 근처로 촘촘히 군집.
    const ang = hashUnit(n.id) * Math.PI * 2;
    const rad = 45 + hashUnit(`${n.id}r`) * 95;
    n.x = clamp(baseX + Math.cos(ang) * rad * 0.6, 40, W - 40);
    n.y = clamp(cy + 60 + Math.abs(Math.sin(ang)) * rad, 40, 555);
  });
  const count = nodes.length;
  const ax = nodes.map((n) => n.x);   // 앵커 = 초기 군집 위치
  const ay = nodes.map((n) => n.y);
  const vx = new Array<number>(count).fill(0);
  const vy = new Array<number>(count).fill(0);
  for (let it = 0; it < 60; it += 1) {
    for (let i = 0; i < count; i += 1) {
      if (nodes[i].type === 'session') continue;
      let fx = (ax[i] - nodes[i].x) * 0.08;   // 앵커 스프링(자기 군집으로 복귀 → 가장자리 쏠림 방지)
      let fy = (ay[i] - nodes[i].y) * 0.08;
      for (let j = 0; j < count; j += 1) {
        if (i === j) continue;
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const d2 = dx * dx + dy * dy;
        if (d2 === 0 || d2 > 2600) continue;   // 근접(≈51px 이내) 겹침만 밀어냄
        const f = 340 / d2;
        fx += dx * f;
        fy += dy * f;
      }
      vx[i] = (vx[i] + fx) * 0.8;
      vy[i] = (vy[i] + fy) * 0.8;
    }
    for (let i = 0; i < count; i += 1) {
      if (nodes[i].type === 'session') continue;
      nodes[i].x = clamp(nodes[i].x + Math.max(-6, Math.min(6, vx[i])), 40, W - 40);
      nodes[i].y = clamp(nodes[i].y + Math.max(-6, Math.min(6, vy[i])), 40, 570);
    }
  }
}

const initialGraphNodes: GraphNode[] = [
  { id: 'S1', type: 'session', label: 'MVP 범위 확정', detail: '오늘 10:00 · 48분', seq: 1, x: 160, y: 280 },
  { id: 'S2', type: 'session', label: 'STT 2-pass 설계', detail: '어제 16:30 · 36분', seq: 2, x: 470, y: 230 },
  { id: 'S3', type: 'session', label: 'GraphRAG 검색 UX', detail: '7월 10일 · 41분', seq: 3, x: 780, y: 280 },
  { id: 'C1', type: 'concept', label: '프로젝트 스키마', detail: '회의·자료·액션 구조', x: 210, y: 110, r: 17 },
  { id: 'C2', type: 'concept', label: '전사 보정', detail: 'STT 품질 개선', x: 420, y: 90, r: 14 },
  { id: 'C3', type: 'concept', label: '자료 연결', detail: '문서 근거 매칭', x: 650, y: 120, r: 18 },
  { id: 'C4', type: 'concept', label: '액션 추출', detail: '결정·할 일 정리', x: 330, y: 420, r: 15 },
  { id: 'C5', type: 'concept', label: 'AI 검색', detail: 'GraphRAG 질의', x: 620, y: 420, r: 19 },
];

const initialGraphLinks: GraphLink[] = [
  { from: 'S1', to: 'C1', rel: 'SESSION_MENTIONS_CONCEPT', label: '근거' },
  { from: 'S1', to: 'C4', rel: 'SESSION_MENTIONS_CONCEPT', label: '근거' },
  { from: 'S2', to: 'C2', rel: 'SESSION_MENTIONS_CONCEPT', label: '근거' },
  { from: 'S2', to: 'C3', rel: 'SESSION_MENTIONS_CONCEPT', label: '근거' },
  { from: 'S3', to: 'C3', rel: 'SESSION_MENTIONS_CONCEPT', label: '근거' },
  { from: 'S3', to: 'C5', rel: 'SESSION_MENTIONS_CONCEPT', label: '근거' },
  { from: 'C1', to: 'C3', rel: 'CONCEPT_CO_OCCURS_WITH', label: '동시출현' },
  { from: 'C3', to: 'C5', rel: 'CONCEPT_CO_OCCURS_WITH', label: '동시출현' },
  { from: 'S1', to: 'S2', rel: 'NEXT_SESSION', label: '다음 세션' },
  { from: 'S2', to: 'S3', rel: 'NEXT_SESSION', label: '다음 세션' },
  { from: 'S1', to: 'S3', rel: 'CONTINUES', label: '연속' },
  { from: 'S2', to: 'S3', rel: 'EXPANDS', label: '확장' },
];

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const graphRelationClass: Record<string, 'mentions' | 'cooccur' | 'next' | 'continues' | 'expands'> = {
  SESSION_MENTIONS_CONCEPT: 'mentions',
  CONCEPT_CO_OCCURS_WITH: 'cooccur',
  NEXT_SESSION: 'next',
  CONTINUES: 'continues',
  EXPANDS: 'expands',
};
const semanticRelations = new Set(['CONTINUES', 'EXPANDS']);

function App() {
  const [projects, setProjects] = useState(initialProjects);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [activeProjectIndex, setActiveProjectIndex] = useState<number | null>(null);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(true);
  const [projectQuery, setProjectQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('전체');
  const [projectSort, setProjectSort] = useState('최근 수정순');
  const [isProjectSortOpen, setIsProjectSortOpen] = useState(false);
  const [homeSection, setHomeSection] = useState('노트북');
  const [authMode, setAuthMode] = useState<'login' | 'signup' | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [sourceModalMode, setSourceModalMode] = useState<'source' | 'record' | null>(null);
  const [selectedSource, setSelectedSource] = useState<SourceItem | null>(null);
  const [isSourceFullscreen, setIsSourceFullscreen] = useState(false);
  const [isRecordingMenuOpen, setIsRecordingMenuOpen] = useState(false);
  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'ready'>('idle');
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [transcriptionState, setTranscriptionState] = useState<'idle' | 'transcribing' | 'done'>('idle');
  const [transcriptionStep, setTranscriptionStep] = useState(0);
  const [openProjectMenuIndex, setOpenProjectMenuIndex] = useState<number | null>(null);
  const [sourceTab, setSourceTab] = useState<(typeof sourceTabs)[number]>('전체');
  const [sourceSort, setSourceSort] = useState<(typeof sourceSortOptions)[number]>('최신순');
  const [isSourceSortOpen, setIsSourceSortOpen] = useState(false);
  const [isSourcePanelOpen, setIsSourcePanelOpen] = useState(true);
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState([
    {
      role: 'assistant',
      text: '프로젝트의 녹음본과 자료를 바탕으로 질문에 답변합니다. 궁금한 내용을 입력하면 가운데 그래프에서 관련 노드를 함께 표시할게요.',
    },
  ]);
  const [graphFocusNodeIds, setGraphFocusNodeIds] = useState<string[]>(['S1', 'C1', 'C3']);
  const [graphViewport, setGraphViewport] = useState({ x: 0, y: 0, scale: 1 });
  const [graphFilter, setGraphFilter] = useState({
    mentions: true,
    cooccur: false,   // 개념-개념 동시출현 엣지는 밀도가 높아 기본 off(필터로 켤 수 있음)
    next: true,
    semantic: true,
    sessionsOnly: false,
  });
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>('S1');
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>(initialGraphNodes);
  const [graphLinks, setGraphLinks] = useState<GraphLink[]>(initialGraphLinks);
  const getGraphNode = (id: string) => graphNodes.find((node) => node.id === id);
  const [graphDragStart, setGraphDragStart] = useState<{
    pointerId: number;
    x: number;
    y: number;
    originX: number;
    originY: number;
  } | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const isClosingRecordingRef = useRef(false);

  // 마운트 시 실제 Graphiti 그래프(/graph)를 불러와 목 데이터를 대체한다.
  // 실패(백엔드 미가동 등) 시엔 기존 목 데이터를 그대로 유지해 화면이 비지 않게 한다.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/graph`, { headers: { 'X-API-Key': API_KEY } });
        if (!res.ok) throw new Error(String(res.status));
        const { nodes, links } = mapGraph(await res.json());
        if (cancelled || nodes.length === 0) return;
        setGraphNodes(nodes);
        setGraphLinks(links);
        const firstSession = nodes.find((node) => node.type === 'session');
        setSelectedGraphNodeId(firstSession ? firstSession.id : null);
        setGraphFocusNodeIds(firstSession ? [firstSession.id] : []);
      } catch {
        // 목 데이터 유지
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const activeProject = activeProjectIndex === null ? null : projects[activeProjectIndex];
  const focusedGraphNodeIds = new Set(graphFocusNodeIds);
  const visibleSourceItems = sourceItems
    .filter((source) => sourceTab === '전체' || source.category === sourceTab)
    .sort((a, b) => {
      if (sourceSort === '오래된순') return b.updatedOrder - a.updatedOrder;
      if (sourceSort === '글자순') return a.title.localeCompare(b.title);
      if (sourceSort === '종류순') return a.category.localeCompare(b.category) || a.updatedOrder - b.updatedOrder;
      return a.updatedOrder - b.updatedOrder;
    });
  const visibleGraphNodeIds = new Set(
    graphNodes
      .filter((node) => !graphFilter.sessionsOnly || node.type === 'session')
      .map((node) => node.id),
  );
  const visibleGraphLinks = graphLinks.filter((link) => {
    if (!visibleGraphNodeIds.has(link.from) || !visibleGraphNodeIds.has(link.to)) return false;
    const relationClass = graphRelationClass[link.rel];
    if (relationClass === 'mentions') return graphFilter.mentions && !graphFilter.sessionsOnly;
    if (relationClass === 'cooccur') return graphFilter.cooccur && !graphFilter.sessionsOnly;
    if (relationClass === 'next') return graphFilter.next;
    if (semanticRelations.has(link.rel)) return graphFilter.semantic;
    return true;
  });
  const visibleProjects = projects
    .map((project, index) => ({ ...project, index }))
    .filter((project) => {
      if (homeSection !== '휴지통' && project.trashed) return false;
      if (homeSection === '즐겨찾기' && !project.favorite) return false;
      if (homeSection === '공유됨' && !project.shared) return false;
      if (homeSection === '휴지통' && !project.trashed) return false;
      const matchesQuery = `${project.name} ${project.description}`.toLowerCase().includes(projectQuery.toLowerCase());
      const matchesStatus = statusFilter === '전체' || project.status === statusFilter;
      return matchesQuery && matchesStatus;
    })
    .sort((a, b) => {
      if (projectSort === '이름순') return a.name.localeCompare(b.name);
      if (projectSort === '녹음 많은 순') return b.recordings - a.recordings;
      return a.index - b.index;
    });

  useEffect(() => {
    window.history.replaceState({ view: 'home' }, '', window.location.pathname);

    const handlePopState = (event: PopStateEvent) => {
      const state = event.state as { view?: string; projectIndex?: number } | null;

      if (state?.view === 'project' && typeof state.projectIndex === 'number') {
        setIsProfileOpen(false);
        setIsHelpOpen(false);
        setActiveProjectIndex(state.projectIndex);
        return;
      }

      if (state?.view === 'profile') {
        setIsProfileOpen(true);
        setIsHelpOpen(false);
        setActiveProjectIndex(null);
        return;
      }

      setIsProfileOpen(false);
      setIsHelpOpen(false);
      setActiveProjectIndex(null);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (authMode === null && !isFeedbackOpen && selectedSource === null) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAuthMode(null);
        setIsFeedbackOpen(false);
        setIsSettingsOpen(false);
        setSelectedSource(null);
        setIsSourceFullscreen(false);
        setIsRecordingMenuOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [authMode, isFeedbackOpen, selectedSource]);

  useEffect(() => () => {
    mediaRecorderRef.current?.stop();
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    if (recordedAudioUrl !== null) URL.revokeObjectURL(recordedAudioUrl);
  }, [recordedAudioUrl]);

  const closeSourceModal = () => {
    isClosingRecordingRef.current = true;
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    if (recordedAudioUrl !== null) {
      URL.revokeObjectURL(recordedAudioUrl);
      setRecordedAudioUrl(null);
    }
    recordingStreamRef.current = null;
    mediaRecorderRef.current = null;
    recordingChunksRef.current = [];
    setRecordingState('idle');
    setRecordingError(null);
    setTranscriptionState('idle');
    setTranscriptionStep(0);
    setSourceModalMode(null);
  };

  const openProject = (index: number) => {
    setIsProfileOpen(false);
    setIsHelpOpen(false);
    setIsSettingsOpen(false);
    setActiveProjectIndex(index);
    window.history.pushState({ view: 'project', projectIndex: index }, '', window.location.pathname);
  };

  const openProjectHome = () => {
    setIsProfileOpen(false);
    setIsHelpOpen(false);
    setIsSettingsOpen(false);
    setActiveProjectIndex(null);
    setHomeSection('노트북');
    window.history.pushState({ view: 'home' }, '', window.location.pathname);
  };

  const openProfile = () => {
    setIsProfileOpen(true);
    setIsHelpOpen(false);
    setIsSettingsOpen(false);
    setActiveProjectIndex(null);
    window.history.pushState({ view: 'profile' }, '', window.location.pathname);
  };

  const completeAuth = () => {
    setIsLoggedIn(true);
    setAuthMode(null);
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setRecordingError('이 브라우저에서는 녹음을 사용할 수 없습니다.');
      return;
    }

    try {
      setRecordingError(null);
      if (recordedAudioUrl !== null) {
        URL.revokeObjectURL(recordedAudioUrl);
        setRecordedAudioUrl(null);
      }
      setTranscriptionState('idle');
      setTranscriptionStep(0);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      isClosingRecordingRef.current = false;
      recordingStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      recordingChunksRef.current = [];

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data);
      });

      recorder.addEventListener('stop', () => {
        if (isClosingRecordingRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        const audioUrl = URL.createObjectURL(blob);
        setRecordedAudioUrl(audioUrl);
        setRecordingState('ready');
        stream.getTracks().forEach((track) => track.stop());
        recordingStreamRef.current = null;
        mediaRecorderRef.current = null;
      });

      recorder.start();
      setRecordingState('recording');
    } catch {
      setRecordingError('마이크 권한을 허용해야 녹음할 수 있습니다.');
      setRecordingState('idle');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  };

  const startTranscription = () => {
    setTranscriptionState('transcribing');
    setTranscriptionStep(1);
    window.setTimeout(() => setTranscriptionStep(2), 450);
    window.setTimeout(() => setTranscriptionStep(3), 900);
    window.setTimeout(() => {
      setTranscriptionState('done');
      setTranscriptionStep(4);
    }, 1350);
  };

  const updateProject = (index: number, updates: Partial<(typeof projects)[number]>) => {
    setProjects((currentProjects) => currentProjects.map((project, projectIndex) => (
      projectIndex === index ? { ...project, ...updates } : project
    )));
    setOpenProjectMenuIndex(null);
  };

  const deleteProject = (index: number) => {
    updateProject(index, { trashed: true });
  };

  const emptyTrash = () => {
    setProjects((currentProjects) => currentProjects.filter((project) => !project.trashed));
    setOpenProjectMenuIndex(null);
  };

  const submitProjectChat = () => {
    const query = chatInput.trim();
    if (!query) return;

    setChatMessages((currentMessages) => [
      ...currentMessages,
      { role: 'user', text: query },
      {
        role: 'assistant',
        text: '자료 연결, GraphRAG 검색 UX, AI 검색 노드가 질문과 가장 가깝습니다. 가운데 그래프에서 강조된 흐름을 따라가면 어떤 녹음본과 개념이 답변 근거가 되는지 확인할 수 있어요.',
      },
    ]);
    setChatInput('');
    setSelectedGraphNodeId('C5');
    setGraphFocusNodeIds(['S2', 'S3', 'C3', 'C5']);
    setGraphViewport({ x: -40, y: 12, scale: 1.12 });
  };

  const handleGraphWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const nextScale = clamp(graphViewport.scale + (event.deltaY > 0 ? -0.08 : 0.08), 0.6, 1.8);
    setGraphViewport((currentViewport) => ({ ...currentViewport, scale: nextScale }));
  };

  const handleGraphPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest('.graph-svg-node')) return;

    event.currentTarget.setPointerCapture(event.pointerId);
    setGraphDragStart({
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      originX: graphViewport.x,
      originY: graphViewport.y,
    });
  };

  const handleGraphPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (graphDragStart === null) return;
    setGraphViewport((currentViewport) => ({
      ...currentViewport,
      x: graphDragStart.originX + event.clientX - graphDragStart.x,
      y: graphDragStart.originY + event.clientY - graphDragStart.y,
    }));
  };

  const handleGraphPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (graphDragStart?.pointerId === event.pointerId) {
      setGraphDragStart(null);
    }
  };

  const isProjectWorkspace = activeProject !== null && !isProfileOpen;
  const showSidebar = false;

  return (
    <div className={`app-shell ${isSidebarOpen ? '' : 'sidebar-collapsed'} navigationless ${isProjectWorkspace ? 'project-focused' : ''}`}>
      {showSidebar && !isProjectWorkspace && (
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand">
            <div className="sidebar-content">
              <button className="brand-home" type="button" onClick={openProjectHome}>
                SynapVox
              </button>
            </div>
          </div>

          <div className="sidebar-actions">
            <button className="icon-button" type="button" aria-label="프로젝트 검색">
              <span className="search-icon" aria-hidden="true" />
            </button>

            <button
              className="icon-button sidebar-toggle"
              type="button"
              aria-label={isSidebarOpen ? '사이드바 닫기' : '사이드바 열기'}
              aria-expanded={isSidebarOpen}
              onClick={() => setIsSidebarOpen((value) => !value)}
            >
              <span className="panel-icon" aria-hidden="true" />
            </button>
          </div>
        </div>

        <button className="create-project sidebar-content" type="button">
          <span>+</span>
          프로젝트 생성
        </button>

        <div className="sidebar-section sidebar-content">
          {activeProject === null ? (
            <>
              <nav className="home-nav" aria-label="home navigation">
                {homeSections.map((section) => (
                  <button
                    className={homeSection === section ? 'selected' : ''}
                    type="button"
                    key={section}
                    onClick={() => {
                      setIsProfileOpen(false);
                      setActiveProjectIndex(null);
                      setHomeSection(section);
                    }}
                  >
                    {section}
                  </button>
                ))}
              </nav>
            </>
          ) : (
            <>
              <button className="sidebar-back" type="button" onClick={openProjectHome}>
                ← 프로젝트 목록
              </button>

              <div className="project-context">
                <span>현재 프로젝트</span>
                <strong>{activeProject.name}</strong>
              </div>
            </>
          )}
        </div>

        <div className="account-section sidebar-content">
          {isLoggedIn ? (
            <div className="account-row">
              <button className="profile-button" type="button" onClick={openProfile}>
                <span className="avatar">도</span>
                <span>
                  <strong>도원</strong>
                  <small>내 정보</small>
                </span>
              </button>

              <button
                className="logout-button"
                type="button"
                aria-label="로그아웃"
                onClick={() => {
                  setIsLoggedIn(false);
                  setIsProfileOpen(false);
                  setAuthMode(null);
                }}
              >
                <span className="logout-icon" aria-hidden="true" />
              </button>
            </div>
          ) : (
            <div className="auth-actions">
              <button className="login-button" type="button" onClick={() => setAuthMode('login')}>로그인</button>
              <button className="signup-button" type="button" onClick={() => setAuthMode('signup')}>회원가입</button>
            </div>
          )}
        </div>
      </aside>
      )}

      <main className="workspace">
        {!isProjectWorkspace && (
          <header className="app-topbar">
            <button className="topbar-brand" type="button" onClick={openProjectHome}>
              Synap<span>Vox</span>
            </button>

            <div className="topbar-actions">
              <div className="settings-menu-wrap">
                <button
                  className="topbar-icon-button settings-button"
                  type="button"
                  aria-label="설정"
                  aria-expanded={isSettingsOpen}
                  onClick={() => setIsSettingsOpen((value) => !value)}
                >
                  <span className="settings-icon" aria-hidden="true">⚙</span>
                </button>

                {isSettingsOpen && (
                  <div className="settings-menu">
                    <button
                      type="button"
                      onClick={() => {
                        setIsHelpOpen(true);
                        setIsProfileOpen(false);
                        setActiveProjectIndex(null);
                        setIsSettingsOpen(false);
                      }}
                    >
                      도움말
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setIsFeedbackOpen(true);
                        setIsSettingsOpen(false);
                      }}
                    >
                      의견 보내기
                    </button>
                    <button className="settings-language-row" type="button">
                      <span>출력 언어</span>
                      <strong>한국어</strong>
                    </button>
                  </div>
                )}
              </div>

              {isLoggedIn ? (
                <button className="topbar-avatar" type="button" onClick={openProfile} aria-label="내 정보">
                  도
                </button>
              ) : (
                <>
                  <button className="topbar-icon-button" type="button" aria-label="로그인" onClick={() => setAuthMode('login')}>
                    <span className="user-icon" aria-hidden="true" />
                  </button>
                  <button className="topbar-signup-button" type="button" aria-label="회원가입" onClick={() => setAuthMode('signup')}>
                    +
                  </button>
                </>
              )}
            </div>
          </header>
        )}

        {isHelpOpen ? (
          <>
            <header className="workspace-header home-header help-header">
              <div>
                <p className="eyebrow">Help</p>
                <h1>SynapVox 도움말</h1>
                <p className="header-copy">
                  녹음본과 자료를 프로젝트로 묶고, 그래프와 AI 대화로 필요한 근거를 빠르게 찾는 방법을 정리했습니다.
                </p>
              </div>
            </header>

            <section className="help-grid" aria-label="help topics">
              <article className="help-card">
                <span>01</span>
                <h2>프로젝트 만들기</h2>
                <p>홈에서 새 프로젝트를 만들고 녹음본, 문서, 메모 같은 자료를 하나의 작업 공간에 모읍니다.</p>
              </article>
              <article className="help-card">
                <span>02</span>
                <h2>소스 추가</h2>
                <p>프로젝트 안의 소스 영역에서 파일을 드래그하거나 녹음을 시작해 AI 답변의 근거를 채웁니다.</p>
              </article>
              <article className="help-card">
                <span>03</span>
                <h2>그래프 보기</h2>
                <p>가운데 그래프는 녹음본, 개념, 자료 연결을 보여줍니다. 확대, 축소, 드래그로 관계를 탐색할 수 있습니다.</p>
              </article>
              <article className="help-card">
                <span>04</span>
                <h2>AI에게 질문하기</h2>
                <p>오른쪽 대화창에서 질문하면 관련 노드가 함께 강조되어 어떤 자료에서 답이 나왔는지 볼 수 있습니다.</p>
              </article>
            </section>
          </>
        ) : isProfileOpen ? (
          <>
            <header className="workspace-header home-header">
              <div>
                <p className="eyebrow">My profile</p>
                <h1>내 정보</h1>
                <p className="header-copy">
                  계정 정보, 작업 중인 프로젝트, 기본 업로드 설정을 관리하는 공간입니다.
                </p>
              </div>
            </header>

            <section className="profile-grid">
              <article className="profile-card profile-hero">
                <div className="profile-identity">
                  <span className="profile-avatar-large">도</span>
                  <div>
                    <h2>도원</h2>
                    <p>dowon@synapvox.local</p>
                  </div>
                </div>
                <button className="ghost-button" type="button">프로필 수정</button>
              </article>

              <article className="profile-card profile-usage">
                <p className="eyebrow">Usage</p>
                <div className="usage-list">
                  <div>
                    <span>프로젝트</span>
                    <strong>7개</strong>
                  </div>
                  <div>
                    <span>녹음본</span>
                    <strong>46개</strong>
                  </div>
                  <div>
                    <span>자료</span>
                    <strong>107개</strong>
                  </div>
                </div>
              </article>

              <article className="profile-card">
                <p className="eyebrow">Preferences</p>
                <h2>기본 업로드 설정</h2>
                <p>새 녹음본은 자동 전사 후 프로젝트 자료와 함께 분석됩니다.</p>
                <button className="text-button profile-link" type="button">설정 열기</button>
              </article>

              <article className="profile-card">
                <p className="eyebrow">Security</p>
                <h2>계정 관리</h2>
                <p>로그인 방식, 세션, 내보내기 권한을 관리합니다.</p>
                <button className="text-button profile-link" type="button">보안 설정</button>
              </article>
            </section>
          </>
        ) : activeProject === null ? (
          <>
            <section className="home-controls" aria-label="notebook controls">
              <nav className="topbar-tabs" aria-label="project sections">
                {homeSections.map((section) => (
                  <button
                    className={homeSection === section && !isProfileOpen ? 'selected' : ''}
                    type="button"
                    key={section}
                    onClick={() => {
                      setIsProfileOpen(false);
                      setActiveProjectIndex(null);
                      setHomeSection(section);
                    }}
                  >
                    {section}
                  </button>
                ))}
              </nav>

              <div className="home-tool-actions">
                <button className="round-search-button" type="button" aria-label="프로젝트 검색">
                  <span className="search-icon" aria-hidden="true" />
                </button>

                <div className="sort-dropdown">
                  <button
                    className="sort-dropdown-button"
                    type="button"
                    aria-expanded={isProjectSortOpen}
                    onClick={() => setIsProjectSortOpen((value) => !value)}
                  >
                    {projectSort}
                    <span className="chevron-down" aria-hidden="true" />
                  </button>

                  {isProjectSortOpen && (
                    <div className="sort-dropdown-menu">
                      {projectSortOptions.map((option) => (
                        <button
                          className={projectSort === option ? 'selected' : ''}
                          type="button"
                          key={option}
                          onClick={() => {
                            setProjectSort(option);
                            setIsProjectSortOpen(false);
                          }}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <button className="home-create-button" type="button">
                  <span>+</span>
                  새로 만들기
                </button>
              </div>
            </section>

            <section className="project-toolbar compact" aria-label="project controls">
              <label className="project-search">
                <span className="search-icon" aria-hidden="true" />
                <input
                  value={projectQuery}
                  onChange={(event) => setProjectQuery(event.target.value)}
                  placeholder="프로젝트 검색"
                />
              </label>

              <div className="filter-group" aria-label="project status filter">
                {statusFilters.map((filter) => (
                  <button
                    className={filter === statusFilter ? 'selected' : ''}
                    type="button"
                    key={filter}
                    onClick={() => setStatusFilter(filter)}
                  >
                    {filter}
                  </button>
                ))}
              </div>
              {homeSection === '휴지통' && (
                <button className="empty-trash-button" type="button" onClick={emptyTrash}>
                  휴지통 비우기
                </button>
              )}
            </section>

            <section className="home-grid" aria-label="projects">
              {homeSection === '노트북' && (
                <button className="new-project-card" type="button">
                  <span>+</span>
                  <strong>새 프로젝트</strong>
                  <p>녹음본과 자료를 묶을 작업 공간을 만듭니다.</p>
                </button>
              )}

              {visibleProjects.map((project) => (
                <article className="home-project-card" key={project.name}>
                  <button className="project-card-main" type="button" onClick={() => openProject(project.index)}>
                    <div>
                      <span className="project-state">{project.status}</span>
                      <h2>{project.name}</h2>
                      <p>{project.description}</p>
                    </div>
                    <div className="home-card-meta">
                      <b>{project.recordings} 녹음본</b>
                      <b>{project.materials} 자료</b>
                      <em>{project.updatedAt}</em>
                    </div>
                  </button>

                  <div className="project-menu">
                    <button
                      className="project-menu-button"
                      type="button"
                      aria-label={`${project.name} 메뉴`}
                      onClick={() => setOpenProjectMenuIndex((currentIndex) => (
                        currentIndex === project.index ? null : project.index
                      ))}
                    >
                      <span />
                      <span />
                      <span />
                    </button>

                    {openProjectMenuIndex === project.index && (
                      <div className="project-menu-popover">
                        <button type="button" onClick={() => setOpenProjectMenuIndex(null)}>수정</button>
                        <button type="button" onClick={() => updateProject(project.index, { favorite: !project.favorite })}>
                          {project.favorite ? '즐겨찾기 해제' : '즐겨찾기'}
                        </button>
                        {project.trashed ? (
                          <button type="button" onClick={() => updateProject(project.index, { trashed: false })}>복원</button>
                        ) : (
                          <button className="danger" type="button" onClick={() => deleteProject(project.index)}>삭제</button>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              ))}

              {visibleProjects.length === 0 && (
                <article className="empty-project-card">
                  <strong>표시할 프로젝트가 없습니다</strong>
                  <p>검색어 또는 필터를 조정해보세요.</p>
                </article>
              )}
            </section>
          </>
        ) : (
          <>
            <header className="project-topbar">
              <button className="project-list-button" type="button" onClick={openProjectHome}>
                ← 프로젝트 목록
              </button>
              <strong>{activeProject.name}</strong>
              <span>녹음본과 자료 기반 작업 공간</span>
            </header>

            <section className={`project-studio ${isSourcePanelOpen ? '' : 'sources-collapsed'}`}>
              <aside className="studio-sources">
              <div className="studio-panel-head">
                <div>
                  <p className="eyebrow">Sources</p>
                  <h2>소스</h2>
                </div>
                <button
                  className="panel-mini-button source-collapse-button"
                  type="button"
                  aria-label={isSourcePanelOpen ? '소스 패널 접기' : '소스 패널 열기'}
                  aria-expanded={isSourcePanelOpen}
                  onClick={() => setIsSourcePanelOpen((value) => !value)}
                >
                  <span className="panel-icon" aria-hidden="true" />
                </button>
              </div>

              <div className="source-panel-content">
                <div className="source-actions">
                  <button className="source-primary-button" type="button" onClick={() => setSourceModalMode('source')}>+ 소스 추가</button>
                  <button className="record-primary-button" type="button" onClick={() => setSourceModalMode('record')}>녹음 하기</button>
                </div>

                <label className="source-search-box">
                  <span className="search-icon" aria-hidden="true" />
                  <input placeholder="소스 검색" />
                </label>

                <div className="source-tabs" aria-label="source type">
                  {sourceTabs.map((tab) => (
                    <button
                      className={sourceTab === tab ? 'selected' : ''}
                      type="button"
                      key={tab}
                      onClick={() => setSourceTab(tab)}
                    >
                      {tab}
                      <span>{sourceItems.filter((source) => tab === '전체' || source.category === tab).length}</span>
                    </button>
                  ))}
                </div>

                <div className="source-sort">
                  <span>정렬</span>
                  <button
                    className="source-sort-button"
                    type="button"
                    aria-expanded={isSourceSortOpen}
                    onClick={() => setIsSourceSortOpen((value) => !value)}
                  >
                    {sourceSort}
                    <span className="chevron-down" aria-hidden="true" />
                  </button>

                  {isSourceSortOpen && (
                    <div className="source-sort-menu">
                      {sourceSortOptions.map((option) => (
                        <button
                          className={sourceSort === option ? 'selected' : ''}
                          type="button"
                          key={option}
                          onClick={() => {
                            setSourceSort(option);
                            setIsSourceSortOpen(false);
                          }}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="source-list">
                  {visibleSourceItems.map((source) => (
                    <button
                      className="source-card"
                      type="button"
                      key={source.title}
                      title={source.title}
                      onClick={() => {
                        setSelectedSource(source);
                        setIsSourceFullscreen(false);
                        setIsRecordingMenuOpen(false);
                      }}
                    >
                      <span>{source.type}</span>
                      <div>
                        <strong>{source.title}</strong>
                        <small>{source.meta}</small>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
              </aside>

              <section className="studio-graph">
              <div className="graph-view-header">
                <div>
                  <p className="eyebrow">Graph view</p>
                  <h2>{activeProject.name}</h2>
                </div>

                <div className="graph-filters" aria-label="graph filters">
                  {[
                    { key: 'mentions', label: '개념 근거' },
                    { key: 'cooccur', label: '동시출현' },
                    { key: 'next', label: '다음 세션' },
                    { key: 'semantic', label: '연속·확장' },
                  ].map((filter) => (
                    <label
                      className={graphFilter.sessionsOnly && ['mentions', 'cooccur'].includes(filter.key) ? 'disabled' : ''}
                      key={filter.key}
                    >
                      <input
                        type="checkbox"
                        checked={graphFilter[filter.key as keyof typeof graphFilter]}
                        disabled={graphFilter.sessionsOnly && ['mentions', 'cooccur'].includes(filter.key)}
                        onChange={(event) => setGraphFilter((currentFilter) => ({
                          ...currentFilter,
                          [filter.key]: event.target.checked,
                        }))}
                      />
                      <span className={`graph-filter-line ${filter.key}`} />
                      {filter.label}
                    </label>
                  ))}

                  <label>
                    <input
                      type="checkbox"
                      checked={graphFilter.sessionsOnly}
                      onChange={(event) => setGraphFilter((currentFilter) => ({
                        ...currentFilter,
                        sessionsOnly: event.target.checked,
                      }))}
                    />
                    세션만
                  </label>
                </div>

                <div className="graph-controls">
                  <button
                    type="button"
                    onClick={() => setGraphViewport((currentViewport) => ({
                      ...currentViewport,
                      scale: clamp(currentViewport.scale - 0.1, 0.6, 1.8),
                    }))}
                  >
                    -
                  </button>
                  <span>{Math.round(graphViewport.scale * 100)}%</span>
                  <button
                    type="button"
                    onClick={() => setGraphViewport((currentViewport) => ({
                      ...currentViewport,
                      scale: clamp(currentViewport.scale + 0.1, 0.6, 1.8),
                    }))}
                  >
                    +
                  </button>
                  <button type="button" onClick={() => setGraphViewport({ x: 0, y: 0, scale: 1 })}>
                    초기화
                  </button>
                </div>
              </div>

              <div
                className={`graph-canvas studio-graph-canvas ${graphDragStart === null ? '' : 'dragging'}`}
                onWheel={handleGraphWheel}
                onPointerDown={handleGraphPointerDown}
                onPointerMove={handleGraphPointerMove}
                onPointerUp={handleGraphPointerUp}
                onPointerCancel={handleGraphPointerUp}
              >
                <svg className="graph-svg" viewBox="0 0 980 580" role="img" aria-label="프로젝트 지식 그래프">
                  <defs>
                    <marker id="arrow-next" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                      <path d="M0,0 L10,5 L0,10 z" />
                    </marker>
                    <marker id="arrow-continues" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                      <path d="M0,0 L10,5 L0,10 z" />
                    </marker>
                    <marker id="arrow-expands" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                      <path d="M0,0 L10,5 L0,10 z" />
                    </marker>
                  </defs>

                  <g className="graph-stage" transform={`translate(${graphViewport.x} ${graphViewport.y}) scale(${graphViewport.scale})`}>
                    <g className="graph-edge-layer">
                      {visibleGraphLinks.map((link) => {
                        const from = getGraphNode(link.from);
                        const to = getGraphNode(link.to);
                        if (from === undefined || to === undefined) return null;

                        const relationClass = graphRelationClass[link.rel];
                        const isFocused = graphFocusNodeIds.length === 0 || (
                          focusedGraphNodeIds.has(link.from) && focusedGraphNodeIds.has(link.to)
                        );
                        const marker = relationClass === 'next'
                          ? 'url(#arrow-next)'
                          : relationClass === 'continues'
                            ? 'url(#arrow-continues)'
                            : relationClass === 'expands'
                              ? 'url(#arrow-expands)'
                              : undefined;

                        return (
                          <line
                            className={`graph-edge ${relationClass} ${isFocused ? 'focused' : 'dimmed'}`}
                            key={`${link.from}-${link.to}-${link.rel}`}
                            x1={from.x}
                            y1={from.y}
                            x2={to.x}
                            y2={to.y}
                            markerEnd={marker}
                          />
                        );
                      })}
                    </g>

                    <g className="graph-node-layer">
                      {graphNodes.filter((node) => visibleGraphNodeIds.has(node.id)).map((node) => {
                        const isFocused = graphFocusNodeIds.length === 0 || focusedGraphNodeIds.has(node.id);

                        return (
                          <g
                            className={`graph-svg-node graph-svg-node-${node.type} ${selectedGraphNodeId === node.id ? 'selected' : ''} ${isFocused ? 'focused' : 'dimmed'}`}
                            key={node.id}
                            transform={`translate(${node.x} ${node.y})`}
                            onClick={() => {
                              setSelectedGraphNodeId(node.id);
                              setGraphFocusNodeIds([node.id]);
                            }}
                          >
                            {node.type === 'session' ? (
                              <>
                                <rect x="-24" y="-18" width="48" height="36" rx="9" />
                                <text textAnchor="middle" y="5">{node.seq}</text>
                                <text className="graph-node-caption" textAnchor="middle" y="38">{node.label}</text>
                              </>
                            ) : (
                              <>
                                <circle r={node.r} />
                                {/* 고차수(다리) 개념 + 선택 노드만 라벨 → 라벨 겹침 방지 */}
                                {((node.r ?? 0) >= 11 || selectedGraphNodeId === node.id) && (
                                  <text textAnchor="middle" y={(node.r ?? 14) + 16}>{node.label}</text>
                                )}
                              </>
                            )}
                          </g>
                        );
                      })}
                    </g>
                  </g>
                </svg>

                <div className="graph-legend">
                  <div><span className="legend-session" />세션</div>
                  <div><span className="legend-concept" />개념</div>
                  <div><span className="legend-line continues" />연속</div>
                  <div><span className="legend-line expands" />확장</div>
                  <div><span className="legend-line mentions" />근거</div>
                </div>
              </div>
              </section>

              <aside className="studio-chat">
              <div className="studio-panel-head">
                <div>
                  <p className="eyebrow">AI chat</p>
                  <h2>대화</h2>
                </div>
                <button className="panel-mini-button" type="button" aria-label="대화 메뉴">⋮</button>
              </div>

              <div className="studio-chat-thread">
                {chatMessages.map((message, index) => (
                  <article className={`chat-bubble ${message.role}`} key={`${message.role}-${index}`}>
                    <span>{message.role === 'assistant' ? 'SynapVox' : '나'}</span>
                    <p>{message.text}</p>
                  </article>
                ))}
              </div>

              <form
                className="studio-chat-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitProjectChat();
                }}
              >
                <input
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  placeholder="프로젝트에 대해 질문하세요"
                />
                <button type="submit">→</button>
              </form>
              </aside>
            </section>
          </>
        )}
      </main>

      {authMode !== null && (
        <div className="auth-modal-backdrop" role="presentation" onMouseDown={() => setAuthMode(null)}>
          <section
            className="auth-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button className="auth-close" type="button" aria-label="닫기" onClick={() => setAuthMode(null)}>
              ×
            </button>

            <p className="eyebrow">{authMode === 'login' ? 'Welcome back' : 'Create account'}</p>
            <h2 id="auth-modal-title">
              {authMode === 'login' ? 'SynapVox에 로그인' : 'SynapVox 시작하기'}
            </h2>
            <p>
              {authMode === 'login'
                ? '프로젝트와 녹음본 자료를 이어서 확인하려면 로그인하세요.'
                : '녹음본과 자료를 프로젝트 단위로 정리할 계정을 만듭니다.'}
            </p>

            <form className="auth-form" onSubmit={(event) => {
              event.preventDefault();
              completeAuth();
            }}>
              {authMode === 'signup' && (
                <label>
                  이름
                  <input type="text" placeholder="도원" autoComplete="name" />
                </label>
              )}

              <label>
                이메일
                <input type="email" placeholder="you@synapvox.com" autoComplete="email" />
              </label>

              <label>
                비밀번호
                <input
                  type="password"
                  placeholder="비밀번호"
                  autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                />
              </label>

              <button className="auth-submit" type="submit">
                {authMode === 'login' ? '로그인' : '회원가입'}
              </button>

              <button
                className="auth-switch"
                type="button"
                onClick={() => setAuthMode(authMode === 'login' ? 'signup' : 'login')}
              >
                {authMode === 'login' ? '계정이 없나요? 회원가입' : '이미 계정이 있나요? 로그인'}
              </button>
            </form>
          </section>
        </div>
      )}

      {sourceModalMode !== null && (
        <div className="auth-modal-backdrop" role="presentation" onMouseDown={closeSourceModal}>
          <section
            className="auth-modal source-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="source-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button className="auth-close" type="button" aria-label="닫기" onClick={closeSourceModal}>
              ×
            </button>

            <p className="eyebrow">{sourceModalMode === 'source' ? 'Add source' : 'Record audio'}</p>
            <h2 id="source-modal-title">
              {sourceModalMode === 'source' ? '소스 추가' : '녹음 시작'}
            </h2>
            <p>
              {sourceModalMode === 'source'
                ? '문서, 링크, 메모를 프로젝트 자료로 추가해 AI 답변과 그래프 근거로 사용할 수 있습니다.'
                : '새 녹음본을 만들고 전사, 요약, 그래프 연결을 이어서 진행합니다.'}
            </p>

            {sourceModalMode === 'source' ? (
              <div
                className="source-dropzone"
                role="button"
                tabIndex={0}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => event.preventDefault()}
              >
                <span aria-hidden="true">+</span>
                <strong>파일을 여기에 드래그하세요</strong>
                <p>클릭해서 소스를 추가할 수도 있습니다.</p>
              </div>
            ) : (
              <div className="record-modal-body">
                <div className={`record-ready-dot ${recordingState}`} aria-hidden="true" />
                <strong>
                  {recordingState === 'recording' ? '녹음 중' : recordingState === 'ready' ? '녹음 완료' : '마이크 입력을 기다리는 중'}
                </strong>
                {recordingError !== null && <p className="record-error">{recordingError}</p>}
                {recordedAudioUrl !== null && (
                  <div className="record-playback">
                    <audio controls src={recordedAudioUrl}>
                      <track kind="captions" />
                    </audio>
                    <a href={recordedAudioUrl} download="synapvox-recording.webm">녹음 파일 저장</a>
                  </div>
                )}
                {recordingState === 'ready' && transcriptionState !== 'idle' && (
                  <div className="transcription-panel">
                    <div className="transcription-steps">
                      {['준비', '분석', '전사', '완료'].map((step, index) => {
                        const stepNumber = index + 1;
                        return (
                          <div
                            className={`${transcriptionStep === stepNumber ? 'active' : ''} ${transcriptionStep > stepNumber ? 'done' : ''}`}
                            key={step}
                          >
                            <span>{stepNumber}</span>
                            <strong>{step}</strong>
                          </div>
                        );
                      })}
                    </div>
                    {transcriptionState === 'done' && (
                      <button
                        className="view-recording-step-button"
                        type="button"
                        onClick={() => {
                          const firstRecording = sourceItems.find((source) => source.category === '녹음본');
                          if (firstRecording !== undefined) {
                            closeSourceModal();
                            setSelectedSource(firstRecording);
                            setIsSourceFullscreen(false);
                          }
                        }}
                      >
                        녹음본 보러 가기
                        <span aria-hidden="true">→</span>
                      </button>
                    )}
                  </div>
                )}
                <div className="record-actions">
                  {recordingState === 'recording' ? (
                    <button type="button" onClick={stopRecording}>녹음 정지</button>
                  ) : (
                    <button type="button" onClick={startRecording}>
                      {recordingState === 'ready' ? '다시 녹음' : '녹음 시작'}
                    </button>
                  )}
                  {recordingState === 'ready' && (
                    <button
                      type="button"
                      onClick={startTranscription}
                      disabled={transcriptionState === 'transcribing'}
                    >
                      {transcriptionState === 'transcribing' ? '전사 중...' : transcriptionState === 'done' ? '다시 전사하기' : '전사하기'}
                    </button>
                  )}
                  <button className="secondary" type="button" onClick={closeSourceModal}>닫기</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {isFeedbackOpen && (
        <div className="auth-modal-backdrop" role="presentation" onMouseDown={() => setIsFeedbackOpen(false)}>
          <section
            className="auth-modal feedback-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button className="auth-close" type="button" aria-label="닫기" onClick={() => setIsFeedbackOpen(false)}>
              ×
            </button>

            <p className="eyebrow">Feedback</p>
            <h2 id="feedback-modal-title">의견 보내기</h2>
            <p>불편한 점이나 필요한 기능을 짧게 남겨주세요.</p>

            <form
              className="feedback-form"
              onSubmit={(event) => {
                event.preventDefault();
                setIsFeedbackOpen(false);
              }}
            >
              <label>
                제목
                <input placeholder="예: 그래프 화면 개선 요청" />
              </label>
              <label>
                내용
                <textarea placeholder="어떤 점이 불편했는지 적어주세요." />
              </label>
              <button className="auth-submit" type="submit">보내기</button>
            </form>
          </section>
        </div>
      )}

      {selectedSource !== null && (
        <div
          className={`auth-modal-backdrop source-detail-backdrop ${isSourceFullscreen ? 'fullscreen' : ''}`}
          role="presentation"
          onMouseDown={() => {
            setSelectedSource(null);
            setIsSourceFullscreen(false);
            setIsRecordingMenuOpen(false);
          }}
        >
          <section
            className={`auth-modal source-detail-modal ${selectedSource.category === '녹음본' ? 'recording-detail-modal' : ''} ${isSourceFullscreen ? 'fullscreen' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="source-detail-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            {selectedSource.category === '녹음본' && (
              <div className="recording-detail-top-actions" aria-label="recording actions">
                <button className="recording-action-search" type="button" aria-label="검색">⌕</button>
                <button
                  className="recording-action-expand"
                  type="button"
                  aria-label={isSourceFullscreen ? '중간 창으로 보기' : '전체 화면으로 보기'}
                  onClick={() => setIsSourceFullscreen((value) => !value)}
                >
                  {isSourceFullscreen ? '↙' : '↗'}
                </button>
                <div className="recording-more-menu-wrap">
                  <button
                    type="button"
                    aria-label="더보기"
                    aria-expanded={isRecordingMenuOpen}
                    onClick={() => setIsRecordingMenuOpen((value) => !value)}
                  >
                    ⋮
                  </button>
                  {isRecordingMenuOpen && (
                    <div className="recording-more-menu">
                      <button type="button" onClick={() => setIsRecordingMenuOpen(false)}>참석자 편집</button>
                      <button type="button" onClick={() => setIsRecordingMenuOpen(false)}>이름 변경</button>
                      <button type="button" onClick={() => setIsRecordingMenuOpen(false)}>요약 다시 생성</button>
                      <button className="danger" type="button" onClick={() => setIsRecordingMenuOpen(false)}>휴지통으로 이동</button>
                    </div>
                  )}
                </div>
              </div>
            )}

            <button
              className="auth-close"
              type="button"
              aria-label="닫기"
              onClick={() => {
                setSelectedSource(null);
                setIsSourceFullscreen(false);
                setIsRecordingMenuOpen(false);
              }}
            >
              ×
            </button>

            {selectedSource.category === '녹음본' ? (
              <div className="recording-detail-view">
                <header className="recording-detail-title">
                  <h2 id="source-detail-title">{selectedSource.title}</h2>
                  <p>전체 노트 · 오늘 10:00 · 48분 12초</p>
                </header>

                <div className="recording-detail-grid">
                  <main className="recording-main-column">
                    <section className="recording-keywords">
                      <h3>주요 키워드</h3>
                      <div className="recording-tags">
                        <span>프로젝트 스키마</span>
                        <span>GraphRAG</span>
                        <span>전사 보정</span>
                        <span>자료 연결</span>
                        <span>AI 검색</span>
                        <span>소스 관리</span>
                      </div>
                    </section>

                    <section className="recording-transcript-panel">
                      <div className="recording-section-head">
                        <h3>음성 기록</h3>
                        <div>
                          <button type="button">편집</button>
                          <button type="button">복사</button>
                        </div>
                      </div>

                      <div className="recording-transcript-list">
                        <article>
                          <span>1</span>
                          <div>
                            <strong>화자 1 <em>00:00</em></strong>
                            <p>오늘은 MVP에서 녹음본과 자료가 어떻게 연결되는지 먼저 확정해봅시다.</p>
                          </div>
                          <div className="utterance-toolbar" aria-label="발화 액션">
                            <button type="button" aria-label="복사">
                              <svg className="utterance-icon" viewBox="0 0 24 24" aria-hidden="true">
                                <rect x="8" y="8" width="10" height="12" rx="2" />
                                <path d="M6 16H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
                              </svg>
                            </button>
                            <button type="button" aria-label="북마크">
                              <svg className="utterance-icon" viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M7 4h10v17l-5-4-5 4z" />
                              </svg>
                            </button>
                            <button type="button">⋮</button>
                          </div>
                        </article>
                        <article>
                          <span>2</span>
                          <div>
                            <strong>화자 2 <em>00:09</em></strong>
                            <p>AI 대화에서 어떤 그래프 노드를 강조할지도 같이 정리하면 좋겠습니다. 소스 추가와 녹음 흐름은 단순하게 두고, 필요한 순간에만 상세 내용을 확장해서 확인할 수 있으면 좋겠습니다.</p>
                          </div>
                          <div className="utterance-toolbar" aria-label="발화 액션">
                            <button type="button" aria-label="복사">
                              <svg className="utterance-icon" viewBox="0 0 24 24" aria-hidden="true">
                                <rect x="8" y="8" width="10" height="12" rx="2" />
                                <path d="M6 16H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
                              </svg>
                            </button>
                            <button type="button" aria-label="북마크">
                              <svg className="utterance-icon" viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M7 4h10v17l-5-4-5 4z" />
                              </svg>
                            </button>
                            <button type="button">⋮</button>
                          </div>
                        </article>
                        <article>
                          <span>1</span>
                          <div>
                            <strong>화자 1 <em>00:42</em></strong>
                            <p>전사문은 화자별로 나뉘어 있으면 회의 맥락을 다시 따라가기 쉬울 것 같습니다.</p>
                          </div>
                          <div className="utterance-toolbar" aria-label="발화 액션">
                            <button type="button" aria-label="복사">
                              <svg className="utterance-icon" viewBox="0 0 24 24" aria-hidden="true">
                                <rect x="8" y="8" width="10" height="12" rx="2" />
                                <path d="M6 16H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
                              </svg>
                            </button>
                            <button type="button" aria-label="북마크">
                              <svg className="utterance-icon" viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M7 4h10v17l-5-4-5 4z" />
                              </svg>
                            </button>
                            <button type="button">⋮</button>
                          </div>
                        </article>
                      </div>
                    </section>
                  </main>

                  <aside className="recording-side-column">
                    <section>
                      <h3>메모 · 요약</h3>
                      <div className="recording-summary-card">
                        <strong>AI가 요약한 핵심 내용을 확인하세요.</strong>
                        <p>프로젝트 범위, 전사 보정, 그래프 기반 검색 UX가 주요 논의로 정리되었습니다.</p>
                      </div>
                    </section>

                    <section>
                      <h3>연결 노드</h3>
                      <div className="recording-tags">
                        <span>프로젝트 스키마</span>
                        <span>자료 연결</span>
                        <span>AI 검색</span>
                      </div>
                    </section>
                  </aside>
                </div>

                <div className="recording-player-bar">
                  <span>00:00</span>
                  <button type="button">↺5</button>
                  <button className="play" type="button">▶</button>
                  <button type="button">5↻</button>
                  <span>48:12</span>
                </div>
              </div>
            ) : (
              <>
                <p className="eyebrow">{selectedSource.category}</p>
                <h2 id="source-detail-title">{selectedSource.title}</h2>
                <div className="source-detail-meta">
                  <span>{selectedSource.type}</span>
                  <span>{selectedSource.meta}</span>
                </div>

                <div className="source-detail-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedSource(null);
                      setIsSourceFullscreen(false);
                    }}
                  >
                    닫기
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export default App;

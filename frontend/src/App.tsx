import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import './App.css';
import { supabase } from './supabaseClient';
import GraphModule from './graphmodule/GraphModule';
import type { Session } from '@supabase/supabase-js';
import {
  deleteProjectSource,
  downloadProjectSource,
  loadStoredProjectWorkspace,
  saveRecordingTranscript,
  updateProjectSourcePayload,
  updateStoredTranscriptSegments,
  uploadProjectSource,
  type StoredSourceRow,
} from './sourceStorage';
import {
  createStoredProject,
  loadStoredProjects,
  removeStoredProjectFiles,
  updateStoredProject,
  type StoredProjectRow,
} from './projectStorage';
import {
  createChatSessionId,
  deleteProjectChat,
  loadProjectChats,
  saveProjectChat,
  type StoredChatMessage,
  type StoredChatSession,
} from './chatStorage';

const AssistantMessage = lazy(() => import('./MarkdownMessage'));

type Project = {
  id: string;              // 그래프/벡터 저장소의 프로젝트 네임스페이스 키
  name: string;
  description: string;
  updatedAt: string;
  date?: string;           // 생성일(절대 날짜) — 카드 상단 배지에 표시
  recordings: number;
  materials: number;
  status: string;
  favorite?: boolean;
  shared?: boolean;
  trashed?: boolean;
};

type SourceItem = {
  id: string;
  title: string;
  type: string;
  category: string;
  meta: string;
  updatedOrder: number;
  materialScope?: 'project' | 'recording';
  audioUrl?: string;
  durationLabel?: string;
  attachedMaterials?: SourceItem[];
  mediaKind?: 'audio' | 'video';
  recordingId?: string;
  graphMeetingId?: string;
  storagePath?: string;
  mimeType?: string;
  sizeBytes?: number;
};

type ProjectMaterialFile = {
  source: SourceItem;
  file: File;
};

type IntermediateSegment = {
  id?: number;
  speaker?: string;
  start?: number;
  end?: number;
  text?: string;
};

type IntermediateTranscript = {
  source?: string;
  meeting_id?: string;
  project_id?: string;
  date?: string;
  mode?: string;
  segments?: IntermediateSegment[];
};

type TranscriptSegment = {
  id: number;
  speakerNumber: number;
  speakerLabel: string;
  time: string;
  text: string;
};

type ProjectWorkspace = {
  sources: SourceItem[];
  transcripts: Record<string, TranscriptSegment[]>;
};

type AuthUser = {
  id: string;
  email: string;
  name: string;
  role: string;
};

const INITIAL_CHAT_MESSAGES: StoredChatMessage[] = [{
  role: 'assistant',
  text: '프로젝트의 녹음본과 자료를 바탕으로 질문에 답변합니다. 궁금한 내용을 입력하면 가운데 그래프에서 관련 노드를 함께 표시할게요.',
}];

const PROJECTS_STORAGE_KEY = 'synapvox-projects';
const WORKSPACES_STORAGE_KEY = 'synapvox-project-workspaces';
const ACTIVE_PROJECT_STORAGE_KEY = 'synapvox-active-project';
const SUPABASE_ADMIN_EMAIL = 'root@synapvox.local';
const scopedStorageKey = (baseKey: string, userId: string | null) => `${baseKey}:${userId ?? 'guest'}`;

// 오래 걸리는 요청(전사·그래프 적재·채팅 스트리밍)은 Netlify 프록시(~26초 타임아웃)를
// 우회해 backend로 직접 보낸다. VITE_API_BASE_URL 미설정(로컬 개발) 시 빈 문자열 →
// same-origin(/api → vite proxy)으로 동작. 짧은 요청은 그대로 /api 프록시를 쓴다.
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

const authUserFromSession = (session: Session | null): AuthUser | null => {
  if (session === null) return null;
  const metadataName = session.user.user_metadata.name;
  const email = session.user.email?.toLowerCase() ?? '로그인된 계정';
  const isAdmin = session.user.app_metadata.role === 'admin' || email === SUPABASE_ADMIN_EMAIL;
  return {
    id: session.user.id,
    email,
    name: isAdmin
      ? '관리자'
      : typeof metadataName === 'string' && metadataName.trim() !== ''
      ? metadataName
      : session.user.email?.split('@')[0] ?? '사용자',
    role: isAdmin ? 'admin' : 'user',
  };
};

// 프로젝트 목록을 localStorage에 영속화 — 새로고침해도 프로젝트 id↔그래프 매핑이 유지된다.
const loadCachedProjects = (userId: string | null): Project[] => {
  try {
    const raw = window.localStorage.getItem(scopedStorageKey(PROJECTS_STORAGE_KEY, userId));
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as Project[];
    return Array.isArray(parsed)
      ? parsed.filter((project) => typeof project?.id === 'string' && typeof project?.name === 'string')
      : [];
  } catch {
    return [];
  }
};

const formatProjectUpdatedAt = (value: string) => {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value;
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return '방금';
  if (elapsedMinutes < 60) return `${elapsedMinutes}분 전`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}시간 전`;
  return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric' }).format(new Date(timestamp));
};

const formatProjectDate = (value: string) => {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(timestamp));
};

const hydrateStoredProject = (row: StoredProjectRow): Project => ({
  id: row.id,
  name: row.name,
  description: row.description,
  updatedAt: formatProjectUpdatedAt(row.updated_at),
  date: formatProjectDate(row.created_at),
  recordings: row.recordings,
  materials: row.materials,
  status: row.status,
  favorite: row.favorite,
  shared: row.shared,
  trashed: row.trashed_at !== null,
});

const loadStoredWorkspaces = (userId: string | null): Record<string, ProjectWorkspace> => {
  try {
    const raw = window.localStorage.getItem(scopedStorageKey(WORKSPACES_STORAGE_KEY, userId));
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as Record<string, ProjectWorkspace>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

// HTTP 헤더는 ASCII 제약이 있어 프로젝트 이름(한글 가능) 대신 ASCII 슬러그 id를 쓴다.
const createProjectId = () => `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const createDefaultProjectName = (projects: Project[]) => {
  const activeNames = new Set(
    projects
      .filter((project) => !project.trashed)
      .map((project) => project.name.trim()),
  );
  if (!activeNames.has('새 프로젝트')) return '새 프로젝트';

  let index = 1;
  while (activeNames.has(`새 프로젝트 ${index}`)) {
    index += 1;
  }
  return `새 프로젝트 ${index}`;
};

const homeSections = ['노트북', '즐겨찾기', '공유됨', '휴지통'];
const adminNavItems = ['개요', '사용자', '작업 큐', '비용', '품질', '시스템'];
const projectSortOptions = ['최근 수정순', '이름순', '녹음 많은 순'];
const initialSourceItems: SourceItem[] = [];
const sourceTabs = ['녹음본', '자료'] as const;
const sourceSortOptions = ['최신순', '오래된순', '글자순', '종류순'] as const;

const formatTranscriptTime = (value = 0) => {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(restSeconds).padStart(2, '0')}`;
};

const formatDuration = (milliseconds: number) => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(restSeconds).padStart(2, '0')}`;
};

const formatFileSize = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '크기 미상';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** unitIndex);
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)}${units[unitIndex]}`;
};

const getMaterialSourceType = (file: File) => {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (extension === 'pdf') return 'PDF';
  if (['ppt', 'pptx', 'key'].includes(extension)) return '슬라이드';
  if (['doc', 'docx', 'hwp', 'hwpx'].includes(extension)) return '문서';
  if (['xls', 'xlsx', 'csv'].includes(extension)) return '표';
  return '자료';
};

const getRecordingTitle = (fileName: string | null, fallback: string) => {
  if (fileName === null) return fallback;
  return fileName.replace(/\.[^/.]+$/, '').trim() || fallback;
};

const isTranscribableMediaFile = (file: File) => {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return file.type.startsWith('audio/')
    || file.type.startsWith('video/')
    || ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac', 'webm', 'mp4', 'mov'].includes(extension);
};

const mapIntermediateTranscript = (data: IntermediateTranscript): TranscriptSegment[] => {
  const speakerNumbers = new Map<string, number>();

  return (data.segments ?? [])
    .filter((segment) => typeof segment.text === 'string' && segment.text.trim().length > 0)
    .map((segment, index) => {
      const rawSpeaker = segment.speaker?.trim() || 'UNKNOWN';
      if (!speakerNumbers.has(rawSpeaker)) {
        speakerNumbers.set(rawSpeaker, speakerNumbers.size + 1);
      }
      const speakerNumber = speakerNumbers.get(rawSpeaker) ?? 1;

      return {
        id: segment.id ?? index,
        speakerNumber,
        speakerLabel: `화자 ${speakerNumber}`,
        time: formatTranscriptTime(segment.start),
        text: segment.text?.trim() ?? '',
      };
    });
};

const sourcePayloadForStorage = (source: SourceItem): Record<string, unknown> => {
  const { audioUrl: _audioUrl, attachedMaterials, ...payload } = source;
  return {
    ...payload,
    attachedMaterials: attachedMaterials?.map((material) => sourcePayloadForStorage(material)) ?? [],
  };
};

const hydrateStoredSource = (row: StoredSourceRow, signedAudioUrl?: string): SourceItem => {
  const payload = row.source_payload as Partial<SourceItem>;
  return {
    id: row.id,
    title: typeof payload.title === 'string' ? payload.title : row.original_name,
    type: typeof payload.type === 'string' ? payload.type : row.kind === 'audio' ? '녹음' : '자료',
    category: row.kind === 'audio' ? '녹음본' : '자료',
    meta: typeof payload.meta === 'string' ? payload.meta : row.kind === 'audio' ? '전사 완료' : '자료',
    updatedOrder: typeof payload.updatedOrder === 'number' ? payload.updatedOrder : 0,
    materialScope: row.scope,
    audioUrl: signedAudioUrl,
    durationLabel: typeof payload.durationLabel === 'string' ? payload.durationLabel : undefined,
    attachedMaterials: Array.isArray(payload.attachedMaterials)
      ? payload.attachedMaterials as SourceItem[]
      : [],
    mediaKind: payload.mediaKind === 'video' ? 'video' : row.kind === 'audio' ? 'audio' : undefined,
    recordingId: row.recording_id ?? undefined,
    graphMeetingId: typeof payload.graphMeetingId === 'string' ? payload.graphMeetingId : undefined,
    storagePath: row.storage_path,
    mimeType: row.mime_type ?? undefined,
    sizeBytes: row.size_bytes,
  };
};

const durationLabelToSeconds = (durationLabel: string) => {
  const [minutes = '0', seconds = '0'] = durationLabel.split(':');
  return (Number(minutes) * 60) + Number(seconds);
};

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sourceItems, setSourceItems] = useState(initialSourceItems);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [activeProjectIndex, setActiveProjectIndex] = useState<number | null>(null);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [isAdminOpen, setIsAdminOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isAuthReady, setIsAuthReady] = useState(supabase === null);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authName, setAuthName] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('전체');
  const [projectSort, setProjectSort] = useState('최근 수정순');
  const [isProjectSortOpen, setIsProjectSortOpen] = useState(false);
  const [homeSection, setHomeSection] = useState('노트북');
  const [adminSection, setAdminSection] = useState('개요');
  const [adminQualityRows, setAdminQualityRows] = useState<string[][]>([]);
  const [adminSystemRows, setAdminSystemRows] = useState<string[][]>([]);
  const [authMode, setAuthMode] = useState<'login' | 'signup' | null>(null);
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);
  const [projectMutationState, setProjectMutationState] = useState<'idle' | 'saving' | 'deleting'>('idle');
  const [projectMutationError, setProjectMutationError] = useState<string | null>(null);
  const [pendingProjectAction, setPendingProjectAction] = useState<{
    type: 'trash' | 'permanent' | 'empty';
    projectIndex?: number;
  } | null>(null);
  const [projectDraft, setProjectDraft] = useState({
    name: '',
    description: '',
  });
  const [isProjectTitleEditing, setIsProjectTitleEditing] = useState(false);
  const [isSourceEditing, setIsSourceEditing] = useState(false);
  const [pendingSourceDeletion, setPendingSourceDeletion] = useState<SourceItem | null>(null);
  const [sourceDeletionState, setSourceDeletionState] = useState<'idle' | 'deleting'>('idle');
  const [sourceDeletionError, setSourceDeletionError] = useState<string | null>(null);
  const [projectEditDraft, setProjectEditDraft] = useState({
    name: '',
    description: '',
  });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isFeedbackOpen, setIsFeedbackOpen] = useState(false);
  const [sourceModalMode, setSourceModalMode] = useState<'source' | 'record' | null>(null);
  const [selectedSource, setSelectedSource] = useState<SourceItem | null>(null);
  const [isSourceFullscreen, setIsSourceFullscreen] = useState(false);
  const [isRecordingMenuOpen, setIsRecordingMenuOpen] = useState(false);
  const [recordInputMode, setRecordInputMode] = useState<'record' | 'upload'>('record');
  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'ready'>('idle');
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null);
  const [recordedAudioBlob, setRecordedAudioBlob] = useState<Blob | null>(null);
  const [recordedAudioFileName, setRecordedAudioFileName] = useState<string | null>(null);
  const [recordedAudioDurationLabel, setRecordedAudioDurationLabel] = useState('00:00');
  const [recordedMediaKind, setRecordedMediaKind] = useState<'audio' | 'video'>('audio');
  const [recordingAttachedMaterials, setRecordingAttachedMaterials] = useState<SourceItem[]>([]);
  const [recordingMaterialFiles, setRecordingMaterialFiles] = useState<File[]>([]);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [transcriptionState, setTranscriptionState] = useState<'idle' | 'transcribing' | 'done'>('idle');
  const [transcriptionStep, setTranscriptionStep] = useState(0);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const [transcriptsBySourceId, setTranscriptsBySourceId] = useState<Record<string, TranscriptSegment[]>>({});
  const [isTranscriptEditing, setIsTranscriptEditing] = useState(false);
  const [transcriptCopyState, setTranscriptCopyState] = useState<'idle' | 'copied'>('idle');
  const [lastTranscribedSourceId, setLastTranscribedSourceId] = useState<string | null>(null);
  const [openProjectMenuIndex, setOpenProjectMenuIndex] = useState<number | null>(null);
  const [sourceTab, setSourceTab] = useState<(typeof sourceTabs)[number]>('녹음본');
  const [sourceSort, setSourceSort] = useState<(typeof sourceSortOptions)[number]>('최신순');
  const [isSourceSortOpen, setIsSourceSortOpen] = useState(false);
  const [isSourcePanelOpen, setIsSourcePanelOpen] = useState(true);
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<StoredChatMessage[]>(INITIAL_CHAT_MESSAGES);
  const [chatSessions, setChatSessions] = useState<StoredChatSession[]>([]);
  const [activeChatSessionId, setActiveChatSessionId] = useState<string | null>(null);
  const [isChatMenuOpen, setIsChatMenuOpen] = useState(false);
  const [pendingChatDeletionId, setPendingChatDeletionId] = useState<string | null>(null);
  const [chatDeletionState, setChatDeletionState] = useState<'idle' | 'deleting'>('idle');
  const [chatDeletionError, setChatDeletionError] = useState<string | null>(null);
  const [isChatResponding, setIsChatResponding] = useState(false);
  const [workspaceLoadedProjectId, setWorkspaceLoadedProjectId] = useState<string | null>(null);
  const [graphReloadKey, setGraphReloadKey] = useState(0);
  const [chatGraphExpansion, setChatGraphExpansion] = useState<Set<string> | null>(null);
  const [isDetailAudioPlaying, setIsDetailAudioPlaying] = useState(false);
  const [detailAudioTimeLabel, setDetailAudioTimeLabel] = useState('00:00');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const transcriptionInFlightRef = useRef(false);
  const recordingStreamRef = useRef<MediaStream | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const isClosingRecordingRef = useRef(false);
  const recordingStartedAtRef = useRef<number | null>(null);
  const savedAudioUrlsRef = useRef(new Set<string>());
  const detailAudioRef = useRef<HTMLAudioElement | HTMLVideoElement | null>(null);
  const sourceFileInputRef = useRef<HTMLInputElement | null>(null);
  const recordingFileInputRef = useRef<HTMLInputElement | null>(null);
  const recordingMediaFileInputRef = useRef<HTMLInputElement | null>(null);
  const projectMaterialFilesRef = useRef<Record<string, ProjectMaterialFile[]>>({});
  const shouldSeedDemoRecordingRef = useRef(window.location.search.includes('demoRecording'));
  const sessionUserIdRef = useRef<string | null | undefined>(undefined);
  const workspaceLoadRequestRef = useRef(0);
  const chatLoadRequestRef = useRef(0);
  const projectCountSyncRef = useRef(new Map<string, string>());

  const activeProject = activeProjectIndex === null ? null : projects[activeProjectIndex];
  const activeProjectId = activeProject?.id ?? null;
  const storageUserId = currentUser?.id ?? null;
  const projectMaterialSources = sourceItems.filter((source) => (
    source.category === '자료' && source.materialScope === 'project'
  ));
  const projectMaterialCount = projectMaterialSources.length;
  const recordingMaterialCount = recordingMaterialFiles.length;
  const totalTranscriptionMaterialCount = projectMaterialCount + recordingMaterialCount;

  const apiHeaders = async (projectId: string | null, meetingId?: string): Promise<Record<string, string>> => {
    const token = (await supabase?.auth.getSession())?.data.session?.access_token;
    return {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(projectId !== null ? { 'X-Project-Id': projectId } : {}),
      ...(meetingId ? { 'X-Meeting-Id': meetingId } : {}),
    };
  };
  const visibleSourceItems = sourceItems
    .filter((source) => source.category === sourceTab)
    .sort((a, b) => {
      if (sourceSort === '오래된순') return b.updatedOrder - a.updatedOrder;
      if (sourceSort === '글자순') return a.title.localeCompare(b.title);
      if (sourceSort === '종류순') return a.category.localeCompare(b.category) || a.updatedOrder - b.updatedOrder;
      return a.updatedOrder - b.updatedOrder;
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
  const selectedTranscriptSegments = selectedSource === null
    ? []
    : transcriptsBySourceId[selectedSource.id] ?? [];
  const profileProjectCount = projects.filter((project) => !project.trashed).length;
  const profileRecordingCount = sourceItems.filter((source) => source.category === '녹음본').length;
  const profileMaterialCount = sourceItems.filter((source) => source.category === '자료').length;
  const accountName = currentUser?.name ?? '사용자';
  const accountEmail = currentUser?.email ?? '로그인된 계정';
  const accountInitial = accountName.trim().charAt(0).toUpperCase() || '사';
  const adminUserCount = isLoggedIn ? 1 : 0;
  const adminRecordingCount = projects.reduce((total, project) => total + (project.trashed ? 0 : project.recordings), 0);
  const adminMaterialCount = projects.reduce((total, project) => total + (project.trashed ? 0 : project.materials), 0);
  const adminActiveProjectCount = projects.filter((project) => !project.trashed).length;
  const adminTotalSourceCount = adminRecordingCount + adminMaterialCount;
  const adminRows = [
    {
      label: '사용자/키',
      value: adminUserCount,
      detail: adminUserCount > 0 ? '현재 로그인한 관리자' : '연결된 사용자 없음',
    },
    {
      label: '오늘 비용',
      value: '₩0',
      detail: '수집된 비용 없음',
    },
    {
      label: '작업 큐',
      value: 0,
      detail: '수집된 작업 없음',
    },
    {
      label: '피드백',
      value: 0,
      detail: '수집된 피드백 없음',
    },
  ];
  const adminPipelines: string[][] = [];
  const adminCostBreakdown: string[][] = [];
  const adminUsers = currentUser === null
    ? []
    : [[currentUser.name, currentUser.role, currentUser.email, 'active']];
  const adminBudgetRows: string[][] = [];

  useEffect(() => {
    window.history.replaceState({ view: 'home' }, '', window.location.pathname);

    const handlePopState = (event: PopStateEvent) => {
      const state = event.state as { view?: string; projectIndex?: number } | null;
      const isAdmin = currentUser?.role === 'admin';

      if (state?.view === 'project' && typeof state.projectIndex === 'number') {
        if (isAdmin) {
          setIsAdminOpen(true);
          setIsProfileOpen(false);
          setIsHelpOpen(false);
          setActiveProjectIndex(null);
          return;
        }
        setIsProfileOpen(false);
        setIsAdminOpen(false);
        setIsHelpOpen(false);
        setActiveProjectIndex(state.projectIndex);
        return;
      }

      if (state?.view === 'profile') {
        if (isAdmin) {
          setIsAdminOpen(true);
          setIsProfileOpen(false);
          setIsHelpOpen(false);
          setActiveProjectIndex(null);
          return;
        }
        setIsProfileOpen(true);
        setIsAdminOpen(false);
        setIsHelpOpen(false);
        setActiveProjectIndex(null);
        return;
      }

      if (state?.view === 'admin') {
        setIsAdminOpen(true);
        setIsProfileOpen(false);
        setIsHelpOpen(false);
        setActiveProjectIndex(null);
        return;
      }

      if (isAdmin) {
        setIsAdminOpen(true);
        setIsProfileOpen(false);
        setIsHelpOpen(false);
        setActiveProjectIndex(null);
        return;
      }

      setIsProfileOpen(false);
      setIsAdminOpen(false);
      setIsHelpOpen(false);
      setActiveProjectIndex(null);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [currentUser?.role]);

  useEffect(() => {
    if (
      authMode === null
      && !isProjectModalOpen
      && !isFeedbackOpen
      && selectedSource === null
    ) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAuthMode(null);
        setIsProjectModalOpen(false);
        setIsFeedbackOpen(false);
        setIsSettingsOpen(false);
        setSelectedSource(null);
        setIsSourceFullscreen(false);
        setIsRecordingMenuOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [authMode, isProjectModalOpen, isFeedbackOpen, selectedSource]);

  useEffect(() => () => {
    mediaRecorderRef.current?.stop();
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    if (recordedAudioUrl !== null && !savedAudioUrlsRef.current.has(recordedAudioUrl)) {
      URL.revokeObjectURL(recordedAudioUrl);
    }
  }, [recordedAudioUrl]);

  useEffect(() => {
    setIsDetailAudioPlaying(false);
    setDetailAudioTimeLabel('00:00');
    setIsTranscriptEditing(false);
    setTranscriptCopyState('idle');
    detailAudioRef.current?.pause();
    if (detailAudioRef.current !== null) detailAudioRef.current.currentTime = 0;
  }, [selectedSource]);

  const refreshAdminQuality = async () => {
    try {
      const response = await fetch('/api/admin/quality', { headers: await apiHeaders(null) });
      if (!response.ok) throw new Error(`/api/admin/quality ${response.status}`);
      const data = await response.json() as { rows: string[][] };
      setAdminQualityRows(data.rows ?? []);
    } catch (error) {
      // 통합 API가 안 떠 있어도 나머지 관리자 화면은 정상 동작해야 하므로 조용히 빈 상태로 둔다.
      console.error('품질 벤치마크를 불러오지 못했습니다:', error);
    }
  };

  const refreshAdminSystemHealth = async () => {
    try {
      const response = await fetch('/api/admin/health', { headers: await apiHeaders(null) });
      if (!response.ok) throw new Error(`/api/admin/health ${response.status}`);
      const data = await response.json() as { rows: string[][] };
      setAdminSystemRows(data.rows ?? []);
    } catch (error) {
      console.error('시스템 헬스체크를 불러오지 못했습니다:', error);
    }
  };


  // 프로젝트 목록 영속화 — id↔그래프 네임스페이스 매핑이 새로고침 후에도 유지되게.
  useEffect(() => {
    if (storageUserId === null) return;
    try {
      window.localStorage.setItem(scopedStorageKey(PROJECTS_STORAGE_KEY, storageUserId), JSON.stringify(projects));
    } catch (error) {
      console.error('프로젝트 목록 저장 실패:', error);
    }
  }, [projects, storageUserId]);

  useEffect(() => {
    if (storageUserId === null) return;
    const key = scopedStorageKey(ACTIVE_PROJECT_STORAGE_KEY, storageUserId);
    if (activeProjectId === null) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, activeProjectId);
    window.history.replaceState(
      { view: 'project', projectIndex: activeProjectIndex, projectId: activeProjectId },
      '',
      window.location.pathname,
    );
  }, [activeProjectId, activeProjectIndex, storageUserId]);

  // 프로젝트 전환 시: 그래프를 해당 프로젝트 네임스페이스로 다시 불러오고,
  // 소스 카드·전사 목록도 프로젝트별로 분리 보관/복원한다(이전 프로젝트 데이터가 새 프로젝트에 안 섞이게).
  const sourceItemsRef = useRef(sourceItems);
  sourceItemsRef.current = sourceItems;
  const transcriptsRef = useRef(transcriptsBySourceId);
  transcriptsRef.current = transcriptsBySourceId;
  const projectWorkspacesRef = useRef<Record<string, ProjectWorkspace>>({});
  const prevProjectIdRef = useRef<string | null>(null);

  const persistProjectWorkspaces = useCallback(() => {
    if (storageUserId === null) return;
    try {
      window.localStorage.setItem(
        scopedStorageKey(WORKSPACES_STORAGE_KEY, storageUserId),
        JSON.stringify(projectWorkspacesRef.current),
      );
    } catch (error) {
      console.error('프로젝트 작업공간 저장 실패:', error);
    }
  }, [storageUserId]);

  const switchProjectStorage = (userId: string | null, restoreActiveProject = true) => {
    const nextProjects = userId === null ? [] : loadCachedProjects(userId);
    const storedActiveProjectId = userId === null || !restoreActiveProject
      ? null
      : window.localStorage.getItem(scopedStorageKey(ACTIVE_PROJECT_STORAGE_KEY, userId));
    const restoredProjectIndex = storedActiveProjectId === null
      ? -1
      : nextProjects.findIndex((project) => project.id === storedActiveProjectId && !project.trashed);
    setProjects(nextProjects);
    projectWorkspacesRef.current = userId === null ? {} : loadStoredWorkspaces(userId);
    projectMaterialFilesRef.current = {};
    prevProjectIdRef.current = null;
    setSourceItems([]);
    setTranscriptsBySourceId({});
    setSelectedSource(null);
    setActiveProjectIndex(restoredProjectIndex >= 0 ? restoredProjectIndex : null);
    setHomeSection('노트북');
    setStatusFilter('전체');
    setProjectQuery('');

    if (userId !== null && supabase !== null) {
      void loadStoredProjects(supabase).then((rows) => {
        if (sessionUserIdRef.current !== userId) return;
        const remoteProjects = rows.map(hydrateStoredProject);
        setProjects(remoteProjects);
        const remoteActiveIndex = storedActiveProjectId === null
          ? -1
          : remoteProjects.findIndex((project) => project.id === storedActiveProjectId && !project.trashed);
        setActiveProjectIndex(remoteActiveIndex >= 0 ? remoteActiveIndex : null);
      }).catch((error) => {
        console.error('Supabase 프로젝트 목록 복원 실패:', error);
      });
    }
  };

  useEffect(() => {
    if (supabase === null) {
      setIsLoggedIn(false);
      setCurrentUser(null);
      switchProjectStorage(null);
      setIsAuthReady(true);
      return undefined;
    }

    const syncSession = (session: Session | null) => {
      const user = authUserFromSession(session);
      const nextUserId = user?.id ?? null;
      const userChanged = sessionUserIdRef.current !== nextUserId;
      setIsLoggedIn(user !== null);
      setCurrentUser(user);
      setIsAdminOpen(user?.role === 'admin');
      if (userChanged) {
        sessionUserIdRef.current = nextUserId;
        switchProjectStorage(nextUserId, user?.role !== 'admin');
      }
      setIsAuthReady(true);
    };

    supabase.auth.getSession().then(({ data }) => {
      syncSession(data.session);
    }).catch((error) => {
      console.error('Supabase 세션 확인 실패:', error);
      syncSession(null);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      syncSession(session);
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!shouldSeedDemoRecordingRef.current) return;
    shouldSeedDemoRecordingRef.current = false;

    const demoProjectId = 'p-demo-recording';
    const demoRecordingId = 'recording-demo';
    const demoRecording: SourceItem = {
      id: demoRecordingId,
      title: '테스트 회의 녹음본',
      type: '파일',
      category: '녹음본',
      meta: '전사 완료 · 오늘 09:50 · 테스트 데이터',
      updatedOrder: 0,
      durationLabel: '02:00',
      mediaKind: 'audio',
      attachedMaterials: [],
    };
    const demoTranscript: TranscriptSegment[] = [
      {
        id: 0,
        speakerNumber: 1,
        speakerLabel: '화자 1',
        time: '00:00',
        text: '오늘은 SynapVox의 녹음본 전사 흐름과 그래프 뷰 연결 상태를 간단히 확인하겠습니다.',
      },
      {
        id: 1,
        speakerNumber: 2,
        speakerLabel: '화자 2',
        time: '00:18',
        text: '자료를 넣고 녹음본을 전사하면 소스 카드에 기록되고, 이후 그래프와 AI 대화에서 근거로 사용할 수 있습니다.',
      },
      {
        id: 2,
        speakerNumber: 1,
        speakerLabel: '화자 1',
        time: '00:43',
        text: '지금 데이터는 화면 확인을 위한 임시 녹음본이며, 실제 파일 저장은 Supabase Storage를 붙이면 영구화됩니다.',
      },
    ];

    projectWorkspacesRef.current[demoProjectId] = {
      sources: [demoRecording],
      transcripts: { [demoRecordingId]: demoTranscript },
    };
    persistProjectWorkspaces();
    setSourceItems([demoRecording]);
    setTranscriptsBySourceId({ [demoRecordingId]: demoTranscript });
    setSourceTab('녹음본');
    setProjects((currentProjects) => {
      const demoProject: Project = {
        id: demoProjectId,
        name: '테스트 녹음 프로젝트',
        description: '그래프 뷰와 전사 화면 확인용 임시 프로젝트',
        updatedAt: '방금',
        date: formatProjectDate(new Date().toISOString()),
        recordings: 1,
        materials: 0,
        status: '분석 중',
      };
      const nextProjects = [
        demoProject,
        ...currentProjects.filter((project) => project.id !== demoProjectId && project.name !== demoProject.name),
      ];
      window.setTimeout(() => setActiveProjectIndex(0), 0);
      return nextProjects;
    });
  }, [persistProjectWorkspaces]);

  useEffect(() => {
    const prev = prevProjectIdRef.current;
    if (prev !== null && prev !== activeProjectId) {
      projectWorkspacesRef.current[prev] = {
        sources: sourceItemsRef.current,
        transcripts: transcriptsRef.current,
      };
      persistProjectWorkspaces();
    }
    if (activeProjectId !== null && prev !== activeProjectId) {
      const saved = projectWorkspacesRef.current[activeProjectId];
      setSourceItems(saved?.sources ?? []);
      setTranscriptsBySourceId(saved?.transcripts ?? {});
      setSelectedSource(null);
      setPendingSourceDeletion(null);
      setSourceDeletionError(null);
    }
    prevProjectIdRef.current = activeProjectId;
  }, [activeProjectId, persistProjectWorkspaces]);

  useEffect(() => {
    setWorkspaceLoadedProjectId(null);
    if (supabase === null || currentUser === null || activeProjectId === null) return;
    const projectId = activeProjectId;
    const requestId = workspaceLoadRequestRef.current + 1;
    workspaceLoadRequestRef.current = requestId;

    void loadStoredProjectWorkspace(supabase, projectId).then(({ sources, transcripts, signedUrls }) => {
      if (workspaceLoadRequestRef.current !== requestId || activeProjectId !== projectId) return;
      const restoredSources = sources.map((row, index) => ({
        ...hydrateStoredSource(row, signedUrls.get(row.storage_path)),
        updatedOrder: index,
      }));
      const restoredTranscripts = Object.fromEntries(transcripts.map((row) => [
        row.recording_id,
        Array.isArray(row.segments) ? row.segments as TranscriptSegment[] : [],
      ]));
      setSourceItems(restoredSources);
      setTranscriptsBySourceId(restoredTranscripts);
      projectWorkspacesRef.current[projectId] = {
        sources: restoredSources,
        transcripts: restoredTranscripts,
      };
      setWorkspaceLoadedProjectId(projectId);
      persistProjectWorkspaces();
      setProjects((currentProjects) => currentProjects.map((project) => (
        project.id === projectId
          ? {
              ...project,
              recordings: restoredSources.filter((source) => source.category === '녹음본').length,
              materials: restoredSources.filter((source) => source.category === '자료').length,
            }
          : project
      )));
    }).catch((error) => {
      console.error('Supabase 프로젝트 소스 복원 실패:', error);
    });
  }, [activeProjectId, currentUser, persistProjectWorkspaces]);

  useEffect(() => {
    const requestId = chatLoadRequestRef.current + 1;
    chatLoadRequestRef.current = requestId;
    setChatGraphExpansion(null);
    setIsChatResponding(false);
    setIsChatMenuOpen(false);
    setPendingChatDeletionId(null);
    setChatDeletionError(null);
    if (supabase === null || currentUser === null || activeProjectId === null) {
      setChatMessages(INITIAL_CHAT_MESSAGES);
      setChatSessions([]);
      setActiveChatSessionId(null);
      return;
    }
    const projectId = activeProjectId;
    setChatMessages(INITIAL_CHAT_MESSAGES);
    void loadProjectChats(supabase, projectId).then((sessions) => {
      if (chatLoadRequestRef.current !== requestId) return;
      if (sessions.length > 0) {
        setChatSessions(sessions);
        setActiveChatSessionId(sessions[0].id);
        setChatMessages(sessions[0].messages.length > 0 ? sessions[0].messages : INITIAL_CHAT_MESSAGES);
      } else {
        const session: StoredChatSession = {
          id: createChatSessionId(),
          title: '새 대화',
          messages: [],
          updatedAt: new Date().toISOString(),
        };
        setChatSessions([session]);
        setActiveChatSessionId(session.id);
        setChatMessages(INITIAL_CHAT_MESSAGES);
      }
    }).catch((error) => {
      console.error('프로젝트 대화 목록 복원 실패:', error);
    });
  }, [activeProjectId, currentUser]);

  useEffect(() => {
    if (!isAdminOpen) return;
    void refreshAdminQuality();
    void refreshAdminSystemHealth();
  }, [isAdminOpen]);

  useEffect(() => {
    if (activeProjectId === null) return;
    projectWorkspacesRef.current[activeProjectId] = {
      sources: sourceItems,
      transcripts: transcriptsBySourceId,
    };
    persistProjectWorkspaces();
  }, [activeProjectId, sourceItems, transcriptsBySourceId, persistProjectWorkspaces]);

  useEffect(() => {
    if (
      activeProject === null
      || supabase === null
      || currentUser === null
      || workspaceLoadedProjectId !== activeProject.id
    ) return;
    const recordings = sourceItems.filter((source) => source.category === '녹음본').length;
    const materials = sourceItems.filter((source) => source.category === '자료').length;
    const countKey = `${recordings}:${materials}`;
    if (projectCountSyncRef.current.get(activeProject.id) === countKey) return;
    projectCountSyncRef.current.set(activeProject.id, countKey);

    if (activeProject.recordings !== recordings || activeProject.materials !== materials) {
      setProjects((currentProjects) => currentProjects.map((project) => (
        project.id === activeProject.id ? { ...project, recordings, materials } : project
      )));
    }
    void updateStoredProject(supabase, activeProject.id, { recordings, materials })
      .catch((error) => {
        projectCountSyncRef.current.delete(activeProject.id);
        console.error('프로젝트 소스 수 저장 실패:', error);
      });
  }, [activeProject, currentUser, sourceItems, workspaceLoadedProjectId]);

  const closeSourceModal = () => {
    isClosingRecordingRef.current = true;
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    if (recordedAudioUrl !== null && !savedAudioUrlsRef.current.has(recordedAudioUrl)) {
      URL.revokeObjectURL(recordedAudioUrl);
    }
    setRecordedAudioUrl(null);
    recordingStreamRef.current = null;
    mediaRecorderRef.current = null;
    recordingChunksRef.current = [];
    recordingStartedAtRef.current = null;
    setRecordingState('idle');
    setRecordInputMode('record');
    setRecordedAudioBlob(null);
    setRecordedAudioFileName(null);
    setRecordedMediaKind('audio');
    setRecordedAudioDurationLabel('00:00');
    setRecordingAttachedMaterials([]);
    setRecordingMaterialFiles([]);
    setRecordingError(null);
    setTranscriptionError(null);
    setTranscriptionState('idle');
    setTranscriptionStep(0);
    setSourceModalMode(null);
  };

  const openProject = (index: number) => {
    if (!isLoggedIn) {
      setAuthMode('login');
      return;
    }
    if (currentUser?.role === 'admin') {
      openAdminHome();
      return;
    }
    setIsProfileOpen(false);
    setIsAdminOpen(false);
    setIsHelpOpen(false);
    setIsSettingsOpen(false);
    setIsAccountMenuOpen(false);
    setActiveProjectIndex(index);
    window.history.pushState({ view: 'project', projectIndex: index }, '', window.location.pathname);
  };

  const openProjectHome = () => {
    setIsProfileOpen(false);
    setIsAdminOpen(false);
    setIsHelpOpen(false);
    setIsSettingsOpen(false);
    setIsAccountMenuOpen(false);
    setIsFeedbackOpen(false);
    setIsProjectSortOpen(false);
    setAuthMode(null);
    setActiveProjectIndex(null);
    setHomeSection('노트북');
    window.history.pushState({ view: 'home' }, '', window.location.pathname);
  };

  const openAdminHome = () => {
    setIsProfileOpen(false);
    setIsAdminOpen(true);
    setIsHelpOpen(false);
    setIsSettingsOpen(false);
    setIsAccountMenuOpen(false);
    setActiveProjectIndex(null);
    setAdminSection('개요');
    window.history.pushState({ view: 'admin' }, '', window.location.pathname);
  };

  const openHome = () => {
    if (currentUser?.role === 'admin') {
      openAdminHome();
      return;
    }
    openProjectHome();
  };

  const openProfile = () => {
    if (currentUser?.role === 'admin') {
      openAdminHome();
      return;
    }
    setIsProfileOpen(true);
    setIsAdminOpen(false);
    setIsHelpOpen(false);
    setIsSettingsOpen(false);
    setIsAccountMenuOpen(false);
    setActiveProjectIndex(null);
    window.history.pushState({ view: 'profile' }, '', window.location.pathname);
  };

  const logout = () => {
    void supabase?.auth.signOut();
    sessionUserIdRef.current = null;
    setIsLoggedIn(false);
    setCurrentUser(null);
    switchProjectStorage(null);
    setIsProfileOpen(false);
    setIsAdminOpen(false);
    setIsHelpOpen(false);
    setIsAccountMenuOpen(false);
    setAuthMode(null);
  };

  const closeAuthModal = () => {
    setAuthMode(null);
    setAuthEmail('');
    setAuthPassword('');
    setAuthName('');
    setAuthError(null);
  };

  const completeAuth = () => {
    setIsLoggedIn(true);
    setIsAccountMenuOpen(false);
    closeAuthModal();
  };

  const submitAuth = async () => {
    setAuthError(null);
    setAuthLoading(true);
    try {
      if (supabase === null) {
        throw new Error('Supabase 연결 설정을 확인해주세요.');
      }

      if (supabase !== null) {
        if (authMode === 'signup') {
          const { data, error } = await supabase.auth.signUp({
            email: authEmail,
            password: authPassword,
            options: { data: { name: authName } },
          });
          if (error) throw error;
          if (data.session === null) {
            setAuthMode('login');
            setAuthPassword('');
            setAuthError('가입 확인 이메일을 보냈습니다. 확인 후 로그인해주세요.');
            return;
          }
        } else {
          const loginEmail = authEmail.trim().toLowerCase() === 'root'
            ? SUPABASE_ADMIN_EMAIL
            : authEmail.trim();
          const { error } = await supabase.auth.signInWithPassword({
            email: loginEmail,
            password: authPassword,
          });
          if (error) throw error;
        }
        completeAuth();
      }
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '인증에 실패했습니다.');
    } finally {
      setAuthLoading(false);
    }
  };

  const openCreateProjectModal = () => {
    if (!isLoggedIn) {
      setAuthMode('login');
      return;
    }
    if (currentUser?.role === 'admin') {
      openAdminHome();
      return;
    }
    setProjectDraft({
      name: createDefaultProjectName(projects),
      description: '',
    });
    setProjectMutationError(null);
    setIsProjectModalOpen(true);
  };

  const createProject = async () => {
    if (!isLoggedIn) {
      setAuthMode('login');
      return;
    }
    if (currentUser?.role === 'admin') {
      openAdminHome();
      return;
    }
    if (supabase === null || currentUser === null || projectMutationState !== 'idle') return;
    const name = projectDraft.name.trim() || '새 프로젝트';
    const description = projectDraft.description.trim() || '녹음본과 자료를 묶을 새 작업 공간';
    setProjectMutationState('saving');
    setProjectMutationError(null);
    try {
      const row = await createStoredProject(supabase, {
        id: createProjectId(),
        owner_id: currentUser.id,
        name,
        description,
        status: '자료 필요',
      });
      const nextProject = hydrateStoredProject(row);

      setProjects((currentProjects) => [nextProject, ...currentProjects]);
      setIsProjectModalOpen(false);
      setIsProfileOpen(false);
      setIsAdminOpen(false);
      setIsHelpOpen(false);
      setIsSettingsOpen(false);
      setHomeSection('노트북');
      setStatusFilter('전체');
      setProjectQuery('');
      setActiveProjectIndex(0);
      window.history.pushState({ view: 'project', projectIndex: 0 }, '', window.location.pathname);
    } catch (error) {
      setProjectMutationError(error instanceof Error ? error.message : '프로젝트를 만들지 못했습니다.');
    } finally {
      setProjectMutationState('idle');
    }
  };

  const startProjectEditing = () => {
    if (activeProject === null) return;
    setProjectEditDraft({
      name: activeProject.name,
      description: activeProject.description,
    });
    setIsProjectTitleEditing(true);
  };

  const saveProjectEdits = async () => {
    if (activeProjectIndex === null || activeProject === null || supabase === null || projectMutationState !== 'idle') return;
    const name = projectEditDraft.name.trim() || activeProject?.name || '새 프로젝트';
    const description = projectEditDraft.description.trim() || '녹음본과 자료를 묶을 작업 공간';
    setProjectMutationState('saving');
    try {
      const row = await updateStoredProject(supabase, activeProject.id, { name, description });
      setProjects((currentProjects) => currentProjects.map((project) => (
        project.id === row.id ? hydrateStoredProject(row) : project
      )));
      setIsProjectTitleEditing(false);
    } catch (error) {
      console.error('프로젝트 수정 저장 실패:', error);
    } finally {
      setProjectMutationState('idle');
    }
  };

  const formatTranscriptSegment = (segment: TranscriptSegment) => (
    `[${segment.speakerLabel} ${segment.time}] ${segment.text.trim()}`
  );

  const writeClipboardText = async (text: string) => {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  };

  const copyTranscriptText = async (segments: TranscriptSegment[]) => {
    if (segments.length === 0) return;
    const text = segments.map(formatTranscriptSegment).join('\n');
    await writeClipboardText(text);
    setTranscriptCopyState('copied');
    window.setTimeout(() => setTranscriptCopyState('idle'), 1400);
  };

  const updateTranscriptSegmentText = (sourceId: string, segmentId: number, text: string) => {
    setTranscriptsBySourceId((currentTranscripts) => ({
      ...currentTranscripts,
      [sourceId]: (currentTranscripts[sourceId] ?? []).map((segment) => (
        segment.id === segmentId ? { ...segment, text } : segment
      )),
    }));
  };

  const toggleTranscriptEditing = () => {
    if (isTranscriptEditing && selectedSource !== null && supabase !== null) {
      void updateStoredTranscriptSegments(supabase, selectedSource.id, selectedTranscriptSegments)
        .catch((error) => console.error('Supabase 전사문 수정 저장 실패:', error));
    }
    setIsTranscriptEditing((value) => !value);
  };

  const removeSourceItem = async (sourceId: string, persist = true) => {
    const targetSource = sourceItems.find((source) => source.id === sourceId);
    const recordingBundleId = targetSource?.category === '녹음본'
      ? targetSource.recordingId ?? targetSource.id
      : undefined;
    const removedSources = recordingBundleId === undefined
      ? sourceItems.filter((source) => source.id === sourceId)
      : sourceItems.filter((source) => source.id === sourceId || source.recordingId === recordingBundleId);
    const removedSourceIds = new Set(removedSources.map((source) => source.id));
    if (persist && supabase !== null && targetSource?.storagePath !== undefined) {
      await deleteProjectSource(
        supabase,
        sourceId,
        targetSource.storagePath,
        recordingBundleId,
      );
    }
    if (targetSource?.audioUrl !== undefined) {
      savedAudioUrlsRef.current.delete(targetSource.audioUrl);
      URL.revokeObjectURL(targetSource.audioUrl);
    }
    setSourceItems((currentSourceItems) => currentSourceItems.filter((source) => !removedSourceIds.has(source.id)));
    if (activeProjectId !== null) {
      projectMaterialFilesRef.current[activeProjectId] = (projectMaterialFilesRef.current[activeProjectId] ?? [])
        .filter((entry) => !removedSourceIds.has(entry.source.id));
    }
    if (targetSource !== undefined && activeProjectIndex !== null) {
      const removedRecordingCount = removedSources.filter((source) => source.category === '녹음본').length;
      const removedMaterialCount = removedSources.filter((source) => source.category === '자료').length;
      setProjects((currentProjects) => currentProjects.map((project, projectIndex) => {
        if (projectIndex !== activeProjectIndex) return project;
        return {
          ...project,
          recordings: Math.max(0, project.recordings - removedRecordingCount),
          materials: Math.max(0, project.materials - removedMaterialCount),
          updatedAt: '방금',
        };
      }));
    }
    setTranscriptsBySourceId((currentTranscripts) => {
      const nextTranscripts = { ...currentTranscripts };
      removedSourceIds.forEach((id) => delete nextTranscripts[id]);
      return nextTranscripts;
    });
    if (selectedSource?.id === sourceId) {
      setSelectedSource(null);
      setIsSourceFullscreen(false);
    }
    if (lastTranscribedSourceId === sourceId) setLastTranscribedSourceId(null);
  };

  const requestSourceDeletion = (source: SourceItem) => {
    setPendingSourceDeletion(source);
    setSourceDeletionError(null);
    setSourceDeletionState('idle');
  };

  const confirmSourceDeletion = async () => {
    if (pendingSourceDeletion === null || sourceDeletionState === 'deleting') return;
    setSourceDeletionState('deleting');
    setSourceDeletionError(null);
    try {
      if (activeProjectId === null) throw new Error('프로젝트를 찾지 못했습니다.');
      const params = new URLSearchParams({ project_id: activeProjectId });
      if (pendingSourceDeletion.recordingId) {
        params.set('recording_id', pendingSourceDeletion.recordingId);
      }
      if (pendingSourceDeletion.graphMeetingId) {
        params.set('meeting_id', pendingSourceDeletion.graphMeetingId);
      }
      params.set('title', pendingSourceDeletion.title);
      const response = await fetch(
        `/api/sources/${encodeURIComponent(pendingSourceDeletion.id)}?${params.toString()}`,
        {
          method: 'DELETE',
          headers: await apiHeaders(activeProjectId),
        },
      );
      const body = await response.json().catch(() => null) as {
        detail?: string;
        storage_paths?: string[];
        warnings?: string[];
      } | null;
      if (!response.ok) {
        throw new Error(body?.detail ?? '소스 데이터 삭제에 실패했습니다.');
      }
      if (supabase !== null && (body?.storage_paths?.length ?? 0) > 0) {
        try {
          await removeStoredProjectFiles(supabase, body?.storage_paths ?? []);
        } catch (error) {
          console.error('삭제된 소스의 Storage 파일 정리 실패:', error);
        }
      }
      if ((body?.warnings?.length ?? 0) > 0) {
        console.warn('소스 일부 저장소 정리 경고:', body?.warnings);
      }
      await removeSourceItem(pendingSourceDeletion.id, false);
      setPendingSourceDeletion(null);
      setSourceDeletionState('idle');
      setGraphReloadKey((value) => value + 1);
    } catch (error) {
      setSourceDeletionState('idle');
      setSourceDeletionError(error instanceof Error ? error.message : '삭제 중 문제가 발생했습니다.');
    }
  };

  const renameSourceItem = (sourceId: string) => {
    const targetSource = sourceItems.find((source) => source.id === sourceId);
    if (targetSource === undefined) return;
    const nextTitle = window.prompt('녹음본 이름을 입력하세요.', targetSource.title)?.trim();
    if (!nextTitle) return;

    const renamedSource = { ...targetSource, title: nextTitle, meta: targetSource.meta.replace(/^이름 변경 전 · /, '') };
    setSourceItems((currentSourceItems) => currentSourceItems.map((source) => (
      source.id === sourceId ? renamedSource : source
    )));
    setSelectedSource((currentSource) => (
      currentSource?.id === sourceId ? { ...currentSource, title: nextTitle } : currentSource
    ));
    setIsRecordingMenuOpen(false);
    if (supabase !== null && targetSource.storagePath !== undefined) {
      void updateProjectSourcePayload(supabase, sourceId, sourcePayloadForStorage(renamedSource))
        .catch((error) => console.error('Supabase 소스 이름 저장 실패:', error));
    }
  };

  const createMaterialItems = (
    files: FileList | File[],
    prefix = 'material',
    materialScope: SourceItem['materialScope'] = 'project',
  ) => {
    const fileList = Array.from(files).filter((file) => file.size > 0 || file.name.trim().length > 0);
    if (fileList.length === 0) return [];

    const now = Date.now();
    return fileList.map((file, index): SourceItem => ({
      id: `${prefix}-${now}-${index}`,
      title: file.name,
      type: getMaterialSourceType(file),
      category: '자료',
      materialScope,
      meta: `자료 · ${formatFileSize(file.size)}`,
      updatedOrder: index,
    }));
  };

  // 내부 그래프 API가 지원하는 문서 형식 — 이 외 형식은 소스 카드만 추가한다.
  const isGraphIngestibleDocument = (file: File) => /\.(pdf|pptx|docx|md|txt)$/i.test(file.name);

  const uploadMaterialToGraph = async (
    file: File,
    itemId: string,
    projectId: string | null,
    meetingId?: string,
  ) => {
    const markMeta = (suffix: string) => setSourceItems((items) => items.map((source) => (
      source.id === itemId ? { ...source, meta: `자료 · ${formatFileSize(file.size)} · ${suffix}` } : source
    )));
    try {
      markMeta('그래프 분석 중…');
      const form = new FormData();
      form.append('file', file, file.name);
      const response = await fetch(`${API_BASE}/api/ingest-doc`, {
        method: 'POST',
        headers: {
          ...(await apiHeaders(projectId, meetingId)),
          'X-Source-Id': itemId,
        },
        body: form,
      });
      if (!response.ok) {
        const errorBody = await response.json().catch(() => null) as { detail?: string } | null;
        throw new Error(errorBody?.detail ?? `자료 그래프 반영 요청 실패 (${response.status})`);
      }
      const result = await response.json() as { chunks_ingested: number; concepts_total: number };
      markMeta(`그래프 반영 완료 (청크 ${result.chunks_ingested}개)`);
      setGraphReloadKey((value) => value + 1);
      return true;
    } catch (error) {
      console.error('문서 그래프 반영 실패:', error);
      const message = error instanceof Error ? error.message : '';
      markMeta(message.includes('이미 등록된') ? '중복 — 이미 등록된 문서라 건너뜀' : '그래프 반영 실패');
      return false;
    }
  };

  const persistMaterialFile = async (
    file: File,
    source: SourceItem,
    projectId: string,
    scope: 'project' | 'recording',
    recordingId?: string,
    graphMeetingId?: string,
  ) => {
    if (supabase === null || currentUser === null) return source;
    const row = await uploadProjectSource({
      client: supabase,
      userId: currentUser.id,
      projectId,
      sourceId: source.id,
      recordingId,
      scope,
      kind: 'document',
      file,
      fileName: file.name,
      mimeType: file.type,
      sourcePayload: sourcePayloadForStorage({ ...source, recordingId, graphMeetingId }),
    });
    const persistedSource: SourceItem = {
      ...source,
      recordingId,
      graphMeetingId,
      storagePath: row.storage_path,
      mimeType: row.mime_type ?? undefined,
      sizeBytes: row.size_bytes,
    };
    setSourceItems((items) => items.map((item) => item.id === source.id ? persistedSource : item));
    return persistedSource;
  };

  const getProjectMaterialsForTranscription = async (projectId: string) => {
    const localMaterials = projectMaterialFilesRef.current[projectId] ?? [];
    if (supabase === null) return localMaterials;
    const client = supabase;
    const localIds = new Set(localMaterials.map(({ source }) => source.id));
    const storedMaterials = sourceItems.filter((source) => (
      source.category === '자료'
      && source.materialScope === 'project'
      && source.storagePath !== undefined
      && !localIds.has(source.id)
    ));
    const downloadedMaterials = await Promise.all(storedMaterials.map(async (source) => {
      const blob = await downloadProjectSource(client, source.storagePath ?? '');
      const file = new File([blob], source.title, { type: source.mimeType ?? blob.type });
      return { source, file };
    }));
    return [...localMaterials, ...downloadedMaterials];
  };

  const addProjectMaterialFiles = (files: FileList | File[]) => {
    const fileList = Array.from(files).filter((file) => file.size > 0 || file.name.trim().length > 0);
    const nextMaterials = createMaterialItems(fileList, 'material', 'project');
    if (nextMaterials.length === 0) return 0;
    const projectId = activeProjectId;

    if (projectId !== null) {
      projectMaterialFilesRef.current[projectId] = [
        ...nextMaterials.map((source, index) => ({ source, file: fileList[index] })),
        ...(projectMaterialFilesRef.current[projectId] ?? []),
      ];
    }

    setSourceItems((currentSourceItems) => [
      ...nextMaterials,
      ...currentSourceItems.map((source) => ({ ...source, updatedOrder: source.updatedOrder + nextMaterials.length })),
    ]);
    setSourceTab('자료');
    if (activeProjectIndex !== null) {
      setProjects((currentProjects) => currentProjects.map((project, projectIndex) => (
        projectIndex === activeProjectIndex
          ? { ...project, materials: project.materials + nextMaterials.length, updatedAt: '방금' }
          : project
      )));
    }

    // 원본은 Supabase Storage에 보존하고, 분석 가능한 문서는 Neo4j에도 반영한다.
    fileList.forEach((file, index) => {
      void (async () => {
        try {
          if (projectId !== null) {
            const persistedSource = await persistMaterialFile(
              file,
              nextMaterials[index],
              projectId,
              'project',
            );
            projectMaterialFilesRef.current[projectId] = (projectMaterialFilesRef.current[projectId] ?? [])
              .map((entry) => entry.source.id === persistedSource.id ? { ...entry, source: persistedSource } : entry);
          }
          if (isGraphIngestibleDocument(file)) {
            await uploadMaterialToGraph(file, nextMaterials[index].id, projectId);
          }
        } catch (error) {
          console.error('프로젝트 자료 저장 실패:', error);
          setSourceItems((items) => items.map((source) => source.id === nextMaterials[index].id
            ? { ...source, meta: `${source.meta} · 저장 실패` }
            : source));
        }
      })();
    });

    return nextMaterials.length;
  };

  const addRecordingMaterialFiles = (files: FileList | File[]) => {
    const fileList = Array.from(files).filter((file) => file.size > 0 || file.name.trim().length > 0);
    const nextMaterials = createMaterialItems(fileList, 'recording-material', 'recording');
    if (nextMaterials.length === 0) return 0;

    setSourceItems((currentSourceItems) => [
      ...nextMaterials,
      ...currentSourceItems.map((source) => ({ ...source, updatedOrder: source.updatedOrder + nextMaterials.length })),
    ]);
    setSourceTab('자료');
    if (activeProjectIndex !== null) {
      setProjects((currentProjects) => currentProjects.map((project, projectIndex) => (
        projectIndex === activeProjectIndex
          ? { ...project, materials: project.materials + nextMaterials.length, updatedAt: '방금' }
          : project
      )));
    }

    setRecordingAttachedMaterials((currentMaterials) => [
      ...nextMaterials,
      ...currentMaterials.map((material) => ({
        ...material,
        updatedOrder: material.updatedOrder + nextMaterials.length,
      })),
    ]);
    setRecordingMaterialFiles((currentFiles) => [
      ...fileList,
      ...currentFiles,
    ]);

    return nextMaterials.length;
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setRecordingError('이 브라우저에서는 녹음을 사용할 수 없습니다.');
      return;
    }

    try {
      setRecordingError(null);
      if (recordedAudioUrl !== null && !savedAudioUrlsRef.current.has(recordedAudioUrl)) {
        URL.revokeObjectURL(recordedAudioUrl);
      }
      setRecordedAudioUrl(null);
      setRecordedAudioBlob(null);
      setRecordedAudioFileName(null);
      setRecordedMediaKind('audio');
      setRecordedAudioDurationLabel('00:00');
      setTranscriptionState('idle');
      setTranscriptionStep(0);
      setTranscriptionError(null);

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
        const durationLabel = formatDuration(Date.now() - (recordingStartedAtRef.current ?? Date.now()));
        setRecordedAudioBlob(blob);
        setRecordedAudioUrl(audioUrl);
        setRecordedAudioFileName(null);
        setRecordedMediaKind('audio');
        setRecordedAudioDurationLabel(durationLabel);
        setRecordingState('ready');
        stream.getTracks().forEach((track) => track.stop());
        recordingStreamRef.current = null;
        mediaRecorderRef.current = null;
      });

      recorder.start();
      recordingStartedAtRef.current = Date.now();
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

  const changeRecordInputMode = (mode: 'record' | 'upload') => {
    if (recordInputMode === mode) return;
    setRecordingError(null);
    setRecordInputMode(mode);
  };

  const updateUploadedMediaDuration = (file: File, mediaUrl: string) => {
    const media = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio');
    media.preload = 'metadata';
    media.onloadedmetadata = () => {
      if (Number.isFinite(media.duration)) {
        setRecordedAudioDurationLabel(formatDuration(media.duration * 1000));
      }
    };
    media.src = mediaUrl;
  };

  const selectRecordedMediaFile = (files: FileList | File[]) => {
    const file = Array.from(files).find(isTranscribableMediaFile);
    if (file === undefined) {
      setRecordingError('전사할 수 있는 오디오나 영상 파일을 선택해주세요.');
      return;
    }

    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingStreamRef.current = null;
    mediaRecorderRef.current = null;
    recordingChunksRef.current = [];

    if (recordedAudioUrl !== null && !savedAudioUrlsRef.current.has(recordedAudioUrl)) {
      URL.revokeObjectURL(recordedAudioUrl);
    }

    const mediaUrl = URL.createObjectURL(file);
    setRecordingError(null);
    setTranscriptionError(null);
    setTranscriptionState('idle');
    setTranscriptionStep(0);
    setRecordedAudioBlob(file);
    setRecordedAudioUrl(mediaUrl);
    setRecordedAudioFileName(file.name);
    setRecordedMediaKind(file.type.startsWith('video/') ? 'video' : 'audio');
    setRecordedAudioDurationLabel('00:00');
    setRecordingState('ready');
    updateUploadedMediaDuration(file, mediaUrl);
  };

  const startTranscription = async () => {
    if (transcriptionInFlightRef.current) return;
    if (recordedAudioBlob === null) {
      setTranscriptionError('전사할 녹음 파일이 없습니다.');
      return;
    }
    if (activeProjectId === null) {
      setTranscriptionError('프로젝트를 먼저 선택해주세요.');
      return;
    }
    transcriptionInFlightRef.current = true;

    setTranscriptionError(null);
    setTranscriptionState('transcribing');
    setTranscriptionStep(1);
    const now = new Date();
    const recordingId = `recording-${now.getTime()}`;
    const meetingId = `meeting-${now.getTime()}`;
    const audioFileName = recordedAudioFileName ?? `synapvox-recording-${now.getTime()}.webm`;
    let audioUploadPromise: ReturnType<typeof uploadProjectSource> | null = null;
    let recordingMaterialsPromise: Promise<SourceItem[]> | null = null;

    try {
      const projectMaterialsForTranscription = await getProjectMaterialsForTranscription(activeProjectId);
      const timeLabel = now.toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const pendingLinkedMaterials = [
        ...projectMaterialsForTranscription.map((entry) => entry.source),
        ...recordingAttachedMaterials,
      ];
      if (supabase !== null && currentUser !== null) {
        audioUploadPromise = uploadProjectSource({
          client: supabase,
          userId: currentUser.id,
          projectId: activeProjectId,
          sourceId: recordingId,
          recordingId,
          scope: 'recording',
          kind: 'audio',
          file: recordedAudioBlob,
          fileName: audioFileName,
          mimeType: recordedAudioBlob.type,
          durationSeconds: durationLabelToSeconds(recordedAudioDurationLabel),
          sourcePayload: sourcePayloadForStorage({
            id: recordingId,
            title: getRecordingTitle(recordedAudioFileName, `녹음본 ${timeLabel}`),
            type: recordedAudioFileName === null ? '녹음' : '파일',
            category: '녹음본',
            meta: `전사 중 · 오늘 ${timeLabel}`,
            updatedOrder: 0,
            attachedMaterials: pendingLinkedMaterials,
            mediaKind: recordedMediaKind,
            recordingId,
            graphMeetingId: meetingId,
          }),
        });
        recordingMaterialsPromise = Promise.all(recordingMaterialFiles.map((file, index) => (
          persistMaterialFile(
            file,
            recordingAttachedMaterials[index],
            activeProjectId,
            'recording',
            recordingId,
            meetingId,
          )
        )));
      }
      const body = new FormData();
      body.append('audio', recordedAudioBlob, audioFileName);
      projectMaterialsForTranscription.forEach(({ file }) => {
        body.append('materials', file, file.name);
      });
      recordingMaterialFiles.forEach((file) => {
        body.append('materials', file, file.name);
      });
      body.append('project_id', activeProjectId);
      body.append('meeting_id', meetingId);

      await new Promise((resolve) => window.setTimeout(resolve, 250));
      setTranscriptionStep(2);
      const response = await fetch(`${API_BASE}/api/stt/transcribe`, {
        method: 'POST',
        headers: await apiHeaders(activeProjectId),
        body,
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => null) as { detail?: string } | null;
        throw new Error(errorBody?.detail ?? '전사 요청에 실패했습니다.');
      }

      const result = await response.json() as IntermediateTranscript;
      const transcriptSegments = mapIntermediateTranscript(result);
      const persistedRecordingMaterials = recordingMaterialsPromise === null
        ? recordingAttachedMaterials
        : await recordingMaterialsPromise;

      const savedTranscriptSegments = transcriptSegments;
      const linkedMaterials = [
        ...projectMaterialsForTranscription.map((entry) => entry.source),
        ...persistedRecordingMaterials,
      ].filter((material, index, materials) => (
        materials.findIndex((candidate) => candidate.id === material.id) === index
      ));
      let savedRecording: SourceItem = {
        id: recordingId,
        title: getRecordingTitle(recordedAudioFileName, `녹음본 ${timeLabel}`),
        type: recordedAudioFileName === null ? '녹음' : '파일',
        category: '녹음본',
        meta: `전사 완료 · 오늘 ${timeLabel}${linkedMaterials.length > 0 ? ` · 연결 자료 ${linkedMaterials.length}개` : ''}`,
        updatedOrder: 0,
        audioUrl: recordedAudioUrl ?? undefined,
        durationLabel: recordedAudioDurationLabel,
        attachedMaterials: linkedMaterials,
        mediaKind: recordedMediaKind,
        recordingId,
        graphMeetingId: meetingId,
      };
      if (supabase !== null && currentUser !== null) {
        const audioRow = await audioUploadPromise;
        if (audioRow === null) throw new Error('녹음 파일 저장을 시작하지 못했습니다.');
        savedRecording = {
          ...savedRecording,
          storagePath: audioRow.storage_path,
          mimeType: audioRow.mime_type ?? undefined,
          sizeBytes: audioRow.size_bytes,
        };
        await Promise.all([
          updateProjectSourcePayload(supabase, recordingId, sourcePayloadForStorage(savedRecording)),
          saveRecordingTranscript({
            client: supabase,
            userId: currentUser.id,
            projectId: activeProjectId,
            recordingId,
            meetingId,
            intermediateJson: result as unknown as Record<string, unknown>,
            segments: savedTranscriptSegments,
          }),
        ]);
      }

      if (recordedAudioUrl !== null) savedAudioUrlsRef.current.add(recordedAudioUrl);
      setSourceItems((currentSourceItems) => [
        { ...savedRecording, meta: `${savedRecording.meta} · 그래프 분석 중` },
        ...currentSourceItems
          .filter((source) => source.id !== recordingId)
          .map((source) => ({ ...source, updatedOrder: source.updatedOrder + 1 })),
      ]);
      if (activeProjectIndex !== null) {
        setProjects((currentProjects) => currentProjects.map((project, projectIndex) => (
          projectIndex === activeProjectIndex
            ? { ...project, recordings: project.recordings + 1, updatedAt: '방금' }
            : project
        )));
      }
      setTranscriptsBySourceId((currentTranscripts) => ({
        ...currentTranscripts,
        [recordingId]: savedTranscriptSegments,
      }));
      setLastTranscribedSourceId(recordingId);
      setSourceTab('녹음본');
      setRecordingAttachedMaterials([]);
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      setTranscriptionState('done');
      setTranscriptionStep(3);

      // 전사 결과 저장까지만 사용자 대기 경로에 둔다. Graphiti 지식 추출은 보통
      // 전사 자체보다 오래 걸리므로 뒤에서 수행하고 소스 카드 상태로 결과를 알린다.
      void (async () => {
        try {
          const ingestResponse = await fetch(`${API_BASE}/api/ingest-stt`, {
            method: 'POST',
            headers: {
              ...(await apiHeaders(activeProjectId)),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(result),
          });
          if (!ingestResponse.ok) {
            const errorBody = await ingestResponse.json().catch(() => null) as { detail?: string } | null;
            throw new Error(errorBody?.detail ?? `전사 그래프 반영 요청 실패 (${ingestResponse.status})`);
          }
          await Promise.all(recordingMaterialFiles.map((file, index) => (
            isGraphIngestibleDocument(file)
              ? uploadMaterialToGraph(file, persistedRecordingMaterials[index]?.id ?? '', activeProjectId, meetingId)
              : Promise.resolve(false)
          )));
          setSourceItems((items) => items.map((source) => (
            source.id === recordingId
              ? { ...source, meta: source.meta.replace(' · 그래프 분석 중', '') }
              : source
          )));
          setGraphReloadKey((value) => value + 1);
        } catch (error) {
          console.error('전사 결과를 그래프에 반영하지 못했습니다:', error);
          setSourceItems((items) => items.map((source) => (
            source.id === recordingId
              ? { ...source, meta: source.meta.replace(' · 그래프 분석 중', ' · 그래프 반영 실패') }
              : source
          )));
        }
      })();
      transcriptionInFlightRef.current = false;
    } catch (error) {
      transcriptionInFlightRef.current = false;
      if (supabase !== null) {
        const client = supabase;
        const pendingUploads: Promise<unknown>[] = [];
        if (audioUploadPromise !== null) pendingUploads.push(audioUploadPromise);
        if (recordingMaterialsPromise !== null) pendingUploads.push(recordingMaterialsPromise);
        void Promise.allSettled(pendingUploads).then(() => (
          deleteProjectSource(client, recordingId, undefined, recordingId)
        )).catch((cleanupError) => console.error('실패한 녹음 저장 정리 실패:', cleanupError));
      }
      setTranscriptionState('idle');
      setTranscriptionStep(0);
      setTranscriptionError(error instanceof Error ? error.message : '전사 중 문제가 발생했습니다.');
    }
  };

  const toggleDetailAudio = () => {
    const audio = detailAudioRef.current;
    if (audio === null || selectedSource?.audioUrl === undefined) return;

    if (audio.paused) {
      void audio.play();
      setIsDetailAudioPlaying(true);
    } else {
      audio.pause();
      setIsDetailAudioPlaying(false);
    }
  };

  const updateProject = async (index: number, updates: Partial<Project>) => {
    const target = projects[index];
    if (target === undefined || supabase === null) return;
    setOpenProjectMenuIndex(null);
    try {
      const row = await updateStoredProject(supabase, target.id, {
        ...(updates.name !== undefined ? { name: updates.name } : {}),
        ...(updates.description !== undefined ? { description: updates.description } : {}),
        ...(updates.status !== undefined ? { status: updates.status } : {}),
        ...(updates.recordings !== undefined ? { recordings: updates.recordings } : {}),
        ...(updates.materials !== undefined ? { materials: updates.materials } : {}),
        ...(updates.favorite !== undefined ? { favorite: updates.favorite } : {}),
        ...(updates.shared !== undefined ? { shared: updates.shared } : {}),
      });
      setProjects((currentProjects) => currentProjects.map((project) => (
        project.id === row.id ? hydrateStoredProject(row) : project
      )));
    } catch (error) {
      console.error('프로젝트 저장 실패:', error);
      setProjectMutationError(error instanceof Error ? error.message : '프로젝트를 저장하지 못했습니다.');
    }
  };

  const requestProjectTrash = (index: number) => {
    setOpenProjectMenuIndex(null);
    setProjectMutationError(null);
    setPendingProjectAction({ type: 'trash', projectIndex: index });
  };

  const setProjectTrashState = async (index: number, trashed: boolean) => {
    const target = projects[index];
    if (target === undefined) return;
    const response = await fetch(`/api/projects/${encodeURIComponent(target.id)}/trash`, {
      method: 'PATCH',
      headers: { ...(await apiHeaders(target.id)), 'Content-Type': 'application/json' },
      body: JSON.stringify({ trashed }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { detail?: string } | null;
      throw new Error(body?.detail ?? '프로젝트 상태를 변경하지 못했습니다.');
    }
    setProjects((currentProjects) => currentProjects.map((project) => (
      project.id === target.id ? { ...project, trashed, updatedAt: '방금' } : project
    )));
    setOpenProjectMenuIndex(null);
  };

  const permanentlyDeleteProject = async (project: Project) => {
    const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
      method: 'DELETE',
      headers: await apiHeaders(project.id),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { detail?: string } | null;
      throw new Error(body?.detail ?? '프로젝트를 영구 삭제하지 못했습니다.');
    }
    const body = await response.json() as { storage_paths?: string[]; warnings?: string[] };
    if ((body.warnings?.length ?? 0) > 0) {
      console.warn('프로젝트 일부 저장소 정리 경고:', body.warnings);
    }
    if (supabase !== null) {
      try {
        await removeStoredProjectFiles(supabase, body.storage_paths ?? []);
      } catch (error) {
        console.error('삭제된 프로젝트의 Storage 파일 정리 실패:', error);
      }
    }
    delete projectWorkspacesRef.current[project.id];
    persistProjectWorkspaces();
    window.localStorage.removeItem(scopedStorageKey(ACTIVE_PROJECT_STORAGE_KEY, storageUserId));
  };

  const confirmProjectAction = async () => {
    if (pendingProjectAction === null || projectMutationState === 'deleting') return;
    setProjectMutationState('deleting');
    setProjectMutationError(null);
    try {
      if (pendingProjectAction.type === 'trash' && pendingProjectAction.projectIndex !== undefined) {
        await setProjectTrashState(pendingProjectAction.projectIndex, true);
      } else if (pendingProjectAction.type === 'permanent' && pendingProjectAction.projectIndex !== undefined) {
        const target = projects[pendingProjectAction.projectIndex];
        if (target !== undefined) {
          await permanentlyDeleteProject(target);
          setProjects((currentProjects) => currentProjects.filter((project) => project.id !== target.id));
        }
      } else if (pendingProjectAction.type === 'empty') {
        const trashedProjects = projects.filter((project) => project.trashed);
        const results = await Promise.allSettled(trashedProjects.map(permanentlyDeleteProject));
        const deletedIds = new Set(trashedProjects
          .filter((_, index) => results[index].status === 'fulfilled')
          .map((project) => project.id));
        setProjects((currentProjects) => currentProjects.filter((project) => !deletedIds.has(project.id)));
        const failed = results.filter((result) => result.status === 'rejected');
        if (failed.length > 0) throw new Error(`${failed.length}개 프로젝트를 삭제하지 못했습니다.`);
      }
      setPendingProjectAction(null);
    } catch (error) {
      setProjectMutationError(error instanceof Error ? error.message : '요청을 처리하지 못했습니다.');
    } finally {
      setProjectMutationState('idle');
    }
  };

  const startNewChat = () => {
    if (isChatResponding) return;
    const session: StoredChatSession = {
      id: createChatSessionId(),
      title: '새 대화',
      messages: [],
      updatedAt: new Date().toISOString(),
    };
    setChatSessions((sessions) => [
      session,
      ...sessions.filter((item) => item.messages.length > 0),
    ]);
    setActiveChatSessionId(session.id);
    setChatMessages(INITIAL_CHAT_MESSAGES);
    setChatGraphExpansion(null);
    setPendingChatDeletionId(null);
    setChatDeletionError(null);
    setIsChatMenuOpen(false);
  };

  const selectChatSession = (session: StoredChatSession) => {
    if (isChatResponding) return;
    setActiveChatSessionId(session.id);
    setChatMessages(session.messages.length > 0 ? session.messages : INITIAL_CHAT_MESSAGES);
    setChatGraphExpansion(null);
    setPendingChatDeletionId(null);
    setChatDeletionError(null);
    setIsChatMenuOpen(false);
  };

  const confirmChatDeletion = async () => {
    if (
      pendingChatDeletionId === null
      || chatDeletionState === 'deleting'
      || supabase === null
    ) return;
    const chatId = pendingChatDeletionId;
    setChatDeletionState('deleting');
    setChatDeletionError(null);
    try {
      await deleteProjectChat(supabase, chatId);
      const remainingSessions = chatSessions.filter((session) => session.id !== chatId);
      if (remainingSessions.length > 0) {
        setChatSessions(remainingSessions);
        if (activeChatSessionId === chatId) {
          setActiveChatSessionId(remainingSessions[0].id);
          setChatMessages(
            remainingSessions[0].messages.length > 0
              ? remainingSessions[0].messages
              : INITIAL_CHAT_MESSAGES,
          );
          setChatGraphExpansion(null);
        }
      } else {
        const session: StoredChatSession = {
          id: createChatSessionId(),
          title: '새 대화',
          messages: [],
          updatedAt: new Date().toISOString(),
        };
        setChatSessions([session]);
        setActiveChatSessionId(session.id);
        setChatMessages(INITIAL_CHAT_MESSAGES);
        setChatGraphExpansion(null);
      }
      setPendingChatDeletionId(null);
    } catch (error) {
      setChatDeletionError(error instanceof Error ? error.message : '대화를 삭제하지 못했습니다.');
    } finally {
      setChatDeletionState('idle');
    }
  };

  const submitProjectChat = () => {
    const query = chatInput.trim();
    if (
      !query
      || isChatResponding
      || activeProjectId === null
      || activeChatSessionId === null
      || currentUser === null
      || supabase === null
    ) return;

    const projectId = activeProjectId;
    const chatId = activeChatSessionId;
    const requestId = chatLoadRequestRef.current;
    const history = chatMessages.slice(-30);
    const userMessage: StoredChatMessage = { role: 'user', text: query };
    const pendingMessages: StoredChatMessage[] = [...chatMessages, userMessage, { role: 'assistant', text: '' }];
    setChatMessages(pendingMessages);
    setChatInput('');
    setIsChatResponding(true);

    void (async () => {
      let assistantText = '';
      try {
        const response = await fetch(`${API_BASE}/api/ask-stream`, {
          method: 'POST',
          headers: { ...(await apiHeaders(projectId)), 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: projectId, q: query, k: 6, history }),
        });
        if (!response.ok || response.body === null) throw new Error(`/api/ask-stream ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let streamError: string | null = null;
        const consumeLine = (line: string) => {
          if (!line.trim()) return;
          const event = JSON.parse(line) as {
            type: 'delta' | 'complete' | 'error';
            text?: string;
            answer?: string;
            message?: string;
            expansion?: { nodes?: { id: string }[] };
          };
          if (event.type === 'delta') {
            assistantText += event.text ?? '';
            if (chatLoadRequestRef.current === requestId) {
              setChatMessages([...chatMessages, userMessage, { role: 'assistant', text: assistantText }]);
            }
          } else if (event.type === 'complete') {
            assistantText = event.answer ?? assistantText;
            if (chatLoadRequestRef.current === requestId) {
              setChatGraphExpansion(new Set((event.expansion?.nodes ?? []).map((node) => node.id)));
            }
          } else if (event.type === 'error') {
            streamError = event.message ?? 'AI 답변을 생성하지 못했습니다.';
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          lines.forEach(consumeLine);
          if (done) break;
        }
        consumeLine(buffer);
        if (streamError !== null) throw new Error(streamError);
        if (!assistantText.trim()) throw new Error('빈 답변이 반환되었습니다.');
      } catch (error) {
        console.error('AI 답변을 받아오지 못했습니다:', error);
        assistantText = '답변을 불러오지 못했습니다. 잠시 후 다시 질문해주세요.';
        if (chatLoadRequestRef.current === requestId) setChatGraphExpansion(null);
      }

      const completedMessages: StoredChatMessage[] = [
        ...chatMessages,
        userMessage,
        { role: 'assistant', text: assistantText },
      ];
      if (chatLoadRequestRef.current === requestId) {
        setChatMessages(completedMessages);
        setIsChatResponding(false);
      }
      try {
        const savedSession = await saveProjectChat(
          supabase,
          currentUser.id,
          projectId,
          chatId,
          completedMessages,
        );
        if (chatLoadRequestRef.current === requestId) {
          setChatSessions((sessions) => [
            savedSession,
            ...sessions.filter((session) => session.id !== chatId),
          ]);
        }
      } catch (error) {
        console.error('프로젝트 대화 저장 실패:', error);
      }
    })();
  };

  const isProjectWorkspace = activeProject !== null && !isProfileOpen && !isAdminOpen && !isHelpOpen;
  const showSidebar = false;

  return (
    <div className={`app-shell ${isSidebarOpen ? '' : 'sidebar-collapsed'} navigationless ${isProjectWorkspace ? 'project-focused' : ''} ${isAdminOpen ? 'admin-focused' : ''}`}>
      {showSidebar && !isProjectWorkspace && (
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand">
            <div className="sidebar-content">
              <button className="brand-home" type="button" onClick={openHome}>
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

        <button className="create-project sidebar-content" type="button" onClick={openCreateProjectModal}>
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
            <div className="account-menu-wrap sidebar-account-menu">
              <button
                className="profile-button"
                type="button"
                aria-expanded={isAccountMenuOpen}
                onClick={() => setIsAccountMenuOpen((value) => !value)}
              >
                <span className="avatar">{accountInitial}</span>
                <span>
                  <strong>{accountName}</strong>
                  <small>{currentUser?.role === 'admin' ? '관리자' : '내 정보'}</small>
                </span>
              </button>

              {isAccountMenuOpen && (
                <div className="account-menu">
                  {currentUser?.role !== 'admin' && (
                    <button type="button" onClick={openProfile}>내 정보 보기</button>
                  )}
                  <button className="danger" type="button" onClick={logout}>로그아웃</button>
                </div>
              )}
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
            <button className="topbar-brand" type="button" onClick={openHome}>
              Synap<span>Vox</span>
            </button>

            {isLoggedIn && (
              <div className="topbar-actions">
                <div className="settings-menu-wrap">
                  <button
                    className="topbar-icon-button settings-button"
                    type="button"
                    aria-label="설정"
                    aria-expanded={isSettingsOpen}
                    onClick={() => {
                      setIsAccountMenuOpen(false);
                      setIsSettingsOpen((value) => !value);
                    }}
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
                          setIsAdminOpen(false);
                          setActiveProjectIndex(null);
                          setIsAccountMenuOpen(false);
                          setIsSettingsOpen(false);
                        }}
                      >
                        도움말
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsFeedbackOpen(true);
                          setIsAccountMenuOpen(false);
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

                <div className="account-menu-wrap topbar-account-menu">
                  <button
                    className="topbar-avatar"
                    type="button"
                    aria-label="내 정보"
                    aria-expanded={isAccountMenuOpen}
                    onClick={() => setIsAccountMenuOpen((value) => !value)}
                  >
                    {accountInitial}
                  </button>
                  {isAccountMenuOpen && (
                    <div className="account-menu">
                      {currentUser?.role !== 'admin' && (
                        <button type="button" onClick={openProfile}>내 정보 보기</button>
                      )}
                      <button className="danger" type="button" onClick={logout}>로그아웃</button>
                    </div>
                  )}
                </div>
              </div>
            )}
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
                <h2>자료 추가</h2>
                <p>파일을 넣으면 자료 소스 카드에 표시되고, 녹음 중 넣은 파일은 녹음본 상세에서도 확인할 수 있습니다.</p>
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
        ) : isAdminOpen ? (
          <>
            <section className="admin-console" aria-label="admin dashboard">
              <aside className="admin-rail" aria-label="admin navigation">
                <div>
                  <p className="eyebrow">Admin</p>
                  <h1>운영 관리</h1>
                </div>
                <nav>
                  {adminNavItems.map((item) => (
                    <button
                      className={adminSection === item ? 'selected' : ''}
                      type="button"
                      key={item}
                      onClick={() => setAdminSection(item)}
                    >
                      {item}
                    </button>
                  ))}
                </nav>
                <button className="admin-home-button" type="button" onClick={openAdminHome}>
                  운영 홈
                </button>
              </aside>

              <div className="admin-main">
                <header className="admin-topline">
                  <div>
                    <p className="eyebrow">Service overview</p>
                    <h2>{adminSection === '개요' ? 'SynapVox 운영 상태' : `${adminSection} 관리`}</h2>
                  </div>
                  <div className="admin-top-actions">
                    <span>마지막 동기화 방금</span>
                    <button type="button">로그 내보내기</button>
                  </div>
                </header>

                {adminSection === '개요' && (
                  <>
                    <div className="admin-metrics">
                      {adminRows.map((row) => (
                        <article key={row.label}>
                          <span>{row.label}</span>
                          <strong>{row.value}</strong>
                          <small>{row.detail}</small>
                        </article>
                      ))}
                    </div>

                    <div className="admin-board">
                      <article className="admin-panel admin-panel-large">
                        <div className="admin-panel-header">
                          <div>
                            <p className="eyebrow">Pipeline</p>
                            <h3>최근 작업</h3>
                          </div>
                          <span>{adminActiveProjectCount} 프로젝트 · {adminTotalSourceCount} 소스</span>
                        </div>
                        <div className="admin-table" role="table" aria-label="최근 작업">
                          {adminPipelines.length > 0 ? (
                            adminPipelines.map(([name, detail, status, meta]) => (
                              <div className="admin-table-row" role="row" key={name}>
                                <strong>{name}</strong>
                                <span>{detail}</span>
                                <small>{meta}</small>
                                <mark>{status}</mark>
                              </div>
                            ))
                          ) : (
                            <div className="admin-empty">아직 작업 기록이 없습니다.</div>
                          )}
                        </div>
                      </article>

                      <article className="admin-panel">
                        <div className="admin-panel-header">
                          <div>
                            <p className="eyebrow">Users</p>
                            <h3>사용자 상태</h3>
                          </div>
                        </div>
                        <div className="admin-user-row">
                          <span className="admin-avatar">도</span>
                          <div>
                            <strong>도원</strong>
                            <small>admin · 전체 관리</small>
                          </div>
                          <span className="admin-role">active</span>
                        </div>
                      </article>

                      <article className="admin-panel">
                        <div className="admin-panel-header">
                          <div>
                            <p className="eyebrow">Quality</p>
                            <h3>품질 게이트</h3>
                          </div>
                        </div>
                        <div className="admin-empty">품질 평가 기록이 없습니다.</div>
                      </article>
                    </div>
                  </>
                )}

                {adminSection === '사용자' && (
                  <section className="admin-section-grid">
                    <article className="admin-panel admin-panel-large">
                      <div className="admin-panel-header">
                        <div>
                          <p className="eyebrow">Users</p>
                          <h3>사용자·권한 목록</h3>
                        </div>
                        <button className="admin-small-button" type="button">사용자 초대</button>
                      </div>
                      <div className="admin-table admin-user-table" role="table" aria-label="사용자 목록">
                        {adminUsers.map(([name, role, scope, status]) => (
                          <div className="admin-table-row" role="row" key={name}>
                            <strong>{name}</strong>
                            <span>{role}</span>
                            <small>{scope}</small>
                            <mark>{status}</mark>
                          </div>
                        ))}
                      </div>
                    </article>
                    <article className="admin-panel">
                      <div className="admin-panel-header">
                        <div>
                          <p className="eyebrow">Keys</p>
                          <h3>API 키 정책</h3>
                        </div>
                      </div>
                      <div className="admin-empty">등록된 API 키가 없습니다.</div>
                    </article>
                  </section>
                )}

                {adminSection === '작업 큐' && (
                  <section className="admin-section-grid">
                    <article className="admin-panel admin-panel-large">
                      <div className="admin-panel-header">
                        <div>
                          <p className="eyebrow">Jobs</p>
                          <h3>인제스트·전사 작업 큐</h3>
                        </div>
                        <button className="admin-small-button" type="button">실패 재시도</button>
                      </div>
                      <div className="admin-table" role="table" aria-label="작업 큐">
                        {adminPipelines.length > 0 ? (
                          adminPipelines.map(([name, detail, status, meta]) => (
                            <div className="admin-table-row" role="row" key={name}>
                              <strong>{name}</strong>
                              <span>{detail}</span>
                              <small>{meta}</small>
                              <mark>{status}</mark>
                            </div>
                          ))
                        ) : (
                          <div className="admin-empty">대기 중인 작업이 없습니다.</div>
                        )}
                      </div>
                    </article>
                    <article className="admin-panel">
                      <div className="admin-panel-header">
                        <div>
                          <p className="eyebrow">Rules</p>
                          <h3>작업 규칙</h3>
                        </div>
                      </div>
                      <div className="admin-empty">등록된 작업 규칙이 없습니다.</div>
                    </article>
                  </section>
                )}

                {adminSection === '비용' && (
                  <section className="admin-section-grid">
                    <article className="admin-panel admin-panel-large">
                      <div className="admin-panel-header">
                        <div>
                          <p className="eyebrow">Budget</p>
                          <h3>토큰·비용 예산</h3>
                        </div>
                        <button className="admin-small-button" type="button">알림 설정</button>
                      </div>
                      <div className="admin-table" role="table" aria-label="비용 예산">
                        {adminBudgetRows.length > 0 ? (
                          adminBudgetRows.map(([name, detail, status]) => (
                            <div className="admin-table-row admin-table-row-compact" role="row" key={name}>
                              <strong>{name}</strong>
                              <span>{detail}</span>
                              <mark>{status}</mark>
                            </div>
                          ))
                        ) : (
                          <div className="admin-empty">수집된 비용 데이터가 없습니다.</div>
                        )}
                      </div>
                    </article>
                    <article className="admin-panel">
                      <div className="admin-panel-header">
                        <div>
                          <p className="eyebrow">Stages</p>
                          <h3>단계별 비용</h3>
                        </div>
                      </div>
                      {adminCostBreakdown.length > 0 ? (
                        <div className="admin-cost-list">
                          {adminCostBreakdown.map(([name, detail]) => (
                            <div key={name}>
                              <span>{name}</span>
                              <small>{detail}</small>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="admin-empty">단계별 비용 기록이 없습니다.</div>
                      )}
                    </article>
                  </section>
                )}

                {adminSection === '품질' && (
                  <section className="admin-section-grid">
                    <article className="admin-panel admin-panel-large">
                      <div className="admin-panel-header">
                        <div>
                          <p className="eyebrow">Evaluation</p>
                          <h3>품질 평가 기준</h3>
                        </div>
                        <button className="admin-small-button" type="button" onClick={() => void refreshAdminQuality()}>평가 실행</button>
                      </div>
                      <div className="admin-table" role="table" aria-label="품질 평가">
                        {adminQualityRows.length > 0 ? (
                          adminQualityRows.map(([name, detail, status]) => (
                            <div className="admin-table-row admin-table-row-compact" role="row" key={name}>
                              <strong>{name}</strong>
                              <span>{detail}</span>
                              <mark>{status}</mark>
                            </div>
                          ))
                        ) : (
                          <div className="admin-empty">품질 평가 기록이 없습니다.</div>
                        )}
                      </div>
                    </article>
                    <article className="admin-panel">
                      <div className="admin-panel-header">
                        <div>
                          <p className="eyebrow">Gate</p>
                          <h3>승인 기준</h3>
                        </div>
                      </div>
                      <div className="admin-empty">승인 기준 데이터가 없습니다.</div>
                    </article>
                  </section>
                )}

                {adminSection === '시스템' && (
                  <section className="admin-section-grid">
                    <article className="admin-panel admin-panel-large">
                      <div className="admin-panel-header">
                        <div>
                          <p className="eyebrow">Health</p>
                          <h3>서비스 헬스체크</h3>
                        </div>
                        <button className="admin-small-button" type="button" onClick={() => void refreshAdminSystemHealth()}>새로고침</button>
                      </div>
                      <div className="admin-table" role="table" aria-label="서비스 헬스체크">
                        {adminSystemRows.length > 0 ? (
                          adminSystemRows.map(([name, detail, status]) => (
                            <div className="admin-table-row admin-table-row-compact" role="row" key={name}>
                              <strong>{name}</strong>
                              <span>{detail}</span>
                              <mark>{status}</mark>
                            </div>
                          ))
                        ) : (
                          <div className="admin-empty">헬스체크 데이터가 없습니다.</div>
                        )}
                      </div>
                    </article>
                    <article className="admin-panel">
                      <div className="admin-panel-header">
                        <div>
                          <p className="eyebrow">Incident</p>
                          <h3>알림 규칙</h3>
                        </div>
                      </div>
                      <div className="admin-empty">등록된 알림 규칙이 없습니다.</div>
                    </article>
                  </section>
                )}
              </div>
            </section>
          </>
        ) : isProfileOpen ? (
          <>
            <header className="workspace-header home-header">
              <div>
                <p className="eyebrow">My profile</p>
                <h1>내 정보</h1>
                <p className="header-copy">
                  현재 작업 공간의 계정 상태와 프로젝트 자료 현황을 확인합니다.
                </p>
              </div>
            </header>

            <section className="profile-grid">
              <article className="profile-card profile-hero">
                <div className="profile-identity">
                  <span className="profile-avatar-large">{accountInitial}</span>
                  <div>
                    <h2>{accountName}</h2>
                    <p>{accountEmail}</p>
                  </div>
                </div>
                <button className="ghost-button" type="button" onClick={logout}>로그아웃</button>
              </article>

              <article className="profile-card profile-usage">
                <p className="eyebrow">Workspace</p>
                <div className="usage-list">
                  <div>
                    <span>프로젝트</span>
                    <strong>{profileProjectCount}개</strong>
                  </div>
                  <div>
                    <span>녹음본</span>
                    <strong>{profileRecordingCount}개</strong>
                  </div>
                  <div>
                    <span>자료</span>
                    <strong>{profileMaterialCount}개</strong>
                  </div>
                </div>
              </article>

              <article className="profile-card">
                <p className="eyebrow">Transcription</p>
                <h2>전사 설정</h2>
                <p>녹음본과 업로드 파일은 CLOVA 1차 전사 후, 참고 자료가 있으면 LLM 보정을 시도합니다.</p>
              </article>

              <article className="profile-card">
                <p className="eyebrow">Storage</p>
                <h2>저장 상태</h2>
                <p>계정은 백엔드 인증 API를 거쳐 Supabase Postgres에 저장됩니다. 프로젝트와 소스 영속화는 다음 단계에서 계정별로 분리됩니다.</p>
              </article>
            </section>
          </>
        ) : !isAuthReady ? (
          <section className="signed-out-home" aria-label="loading account">
            <div className="signed-out-copy">
              <p className="eyebrow">SynapVox</p>
              <h1>계정 상태를 확인하고 있어요.</h1>
            </div>
          </section>
        ) : !isLoggedIn ? (
          <section className="signed-out-home" aria-label="login required">
            <div className="signed-out-copy">
              <p className="eyebrow">Lecture knowledge pipeline</p>
              <h1>강의 지식을 한 흐름으로 정리하세요.</h1>
              <p>
                강의 녹음, 수업 자료, 필기를 프로젝트로 묶고 전사문과 지식 그래프로 이어서 복습합니다.
              </p>
              <div className="signed-out-actions">
                <button className="auth-submit" type="button" onClick={() => setAuthMode('login')}>
                  로그인
                </button>
                <button className="ghost-button" type="button" onClick={() => setAuthMode('signup')}>
                  회원가입
                </button>
              </div>
            </div>

            <div className="signed-out-preview" aria-hidden="true">
              <div className="preview-column preview-sources">
                <span>Sources</span>
                <strong>오늘 강의 녹음</strong>
                <strong>강의 슬라이드</strong>
                <strong>수업 필기</strong>
              </div>
              <div className="preview-graph">
                <svg className="preview-graph-svg" viewBox="0 0 300 420" role="img" aria-label="강의 지식 그래프 예시">
                  <line className="preview-link one" x1="92" y1="126" x2="150" y2="214" pathLength={1} />
                  <line className="preview-link two" x1="224" y1="114" x2="150" y2="214" pathLength={1} />
                  <line className="preview-link three" x1="190" y1="330" x2="150" y2="214" pathLength={1} />
                  <line className="preview-link four" x1="86" y1="300" x2="150" y2="214" pathLength={1} />
                  <circle className="preview-node main" cx="150" cy="214" r="38" />
                  <circle className="preview-node one" cx="92" cy="126" r="20" />
                  <circle className="preview-node two" cx="224" cy="114" r="20" />
                  <circle className="preview-node three" cx="190" cy="330" r="20" />
                  <circle className="preview-node four" cx="86" cy="300" r="16" />
                </svg>
              </div>
              <div className="preview-column preview-chat">
                <span>AI</span>
                <p className="preview-question">“오늘 강의에서 시험에 나올 만한 부분만 정리해줘.”</p>
                <div className="preview-answer">
                  교수님이 강조한 개념과 슬라이드 근거를 묶어 핵심 흐름만 정리했어요.
                </div>
                <strong>근거 4개 연결</strong>
              </div>
            </div>
          </section>
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

                <button className="home-create-button" type="button" onClick={openCreateProjectModal}>
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

              {homeSection === '휴지통' && (
                <button
                  className="empty-trash-button"
                  type="button"
                  disabled={!projects.some((project) => project.trashed)}
                  onClick={() => {
                    setProjectMutationError(null);
                    setPendingProjectAction({ type: 'empty' });
                  }}
                >
                  휴지통 비우기
                </button>
              )}
            </section>

            <section className="home-grid" aria-label="projects">
              {homeSection === '노트북' && (
                <button className="new-project-card" type="button" onClick={openCreateProjectModal}>
                  <span>+</span>
                  <strong>새 프로젝트</strong>
                  <p>녹음본과 자료를 묶을 작업 공간을 만듭니다.</p>
                </button>
              )}

              {visibleProjects.map((project) => (
                <article className="home-project-card" key={project.id}>
                  <button className="project-card-main" type="button" onClick={() => openProject(project.index)}>
                    <div>
                      <span className="project-state">{project.date || project.updatedAt}</span>
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
                        <button type="button" onClick={() => void updateProject(project.index, { favorite: !project.favorite })}>
                          {project.favorite ? '즐겨찾기 해제' : '즐겨찾기'}
                        </button>
                        {project.trashed ? (
                          <>
                            <button type="button" onClick={() => void setProjectTrashState(project.index, false)}>복원</button>
                            <button
                              className="danger"
                              type="button"
                              onClick={() => {
                                setOpenProjectMenuIndex(null);
                                setProjectMutationError(null);
                                setPendingProjectAction({ type: 'permanent', projectIndex: project.index });
                              }}
                            >
                              영구 삭제
                            </button>
                          </>
                        ) : (
                          <button className="danger" type="button" onClick={() => requestProjectTrash(project.index)}>삭제</button>
                        )}
                      </div>
                    )}
                  </div>
                </article>
              ))}

            </section>
          </>
        ) : (
          <>
            <header className="project-topbar">
              <button className="project-list-button" type="button" onClick={openProjectHome}>
                ← 프로젝트 목록
              </button>
              <div
                className={`project-title-block ${isProjectTitleEditing ? 'editing' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (!isProjectTitleEditing) startProjectEditing();
                }}
                onKeyDown={(event) => {
                  if (!isProjectTitleEditing && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    startProjectEditing();
                  }
                }}
                onBlur={(event) => {
                  const nextTarget = event.relatedTarget;
                  if (isProjectTitleEditing && !event.currentTarget.contains(nextTarget)) {
                    void saveProjectEdits();
                  }
                }}
              >
                {isProjectTitleEditing ? (
                  <>
                    <input
                      className="project-title-input"
                      value={projectEditDraft.name}
                      onChange={(event) => setProjectEditDraft((draft) => ({ ...draft, name: event.target.value }))}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void saveProjectEdits();
                      }}
                      autoFocus
                    />
                    <input
                      className="project-description-input"
                      value={projectEditDraft.description}
                      onChange={(event) => setProjectEditDraft((draft) => ({ ...draft, description: event.target.value }))}
                      placeholder="프로젝트 설명"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void saveProjectEdits();
                      }}
                    />
                  </>
                ) : (
                  <>
                    <strong>{activeProject.name}</strong>
                    <span>{activeProject.description}</span>
                  </>
                )}
              </div>
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
                  <div className="project-material-action">
                    <button className="source-primary-button" type="button" onClick={() => setSourceModalMode('source')}>+ 프로젝트 자료</button>
                    <p>이 프로젝트의 모든 녹음 전사와 AI 답변에 참고돼요.</p>
                  </div>
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
                      <span>{sourceItems.filter((source) => source.category === tab).length}</span>
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
                    <article
                      className={`source-card-wrap ${isSourceEditing ? 'editing' : ''}`}
                      key={source.id}
                    >
                      <button
                        className="source-card"
                        type="button"
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
                      {isSourceEditing && (
                        <button
                          className="source-delete-button"
                          type="button"
                          aria-label={`${source.title} 삭제`}
                          onClick={() => requestSourceDeletion(source)}
                        >
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M3 6h18" />
                            <path d="M8 6V4h8v2" />
                            <path d="M6 6l1 15h10l1-15" />
                            <path d="M10 10v7" />
                            <path d="M14 10v7" />
                          </svg>
                        </button>
                      )}
                    </article>
                  ))}
                  {visibleSourceItems.length === 0 && (
                    <div className="source-list-empty">
                      {sourceTab === '녹음본' ? '아직 녹음본이 없습니다.' : '아직 자료가 없습니다.'}
                    </div>
                  )}
                </div>

                {pendingSourceDeletion !== null && (
                  <div className="source-delete-confirm-backdrop" role="presentation">
                    <div
                      className="source-delete-confirm"
                      role="alertdialog"
                      aria-modal="true"
                      aria-labelledby="source-delete-confirm-title"
                    >
                      <strong id="source-delete-confirm-title">삭제하시겠습니까?</strong>
                      <p title={pendingSourceDeletion.title}>{pendingSourceDeletion.title}</p>
                      {sourceDeletionError !== null && (
                        <span className="source-delete-error">{sourceDeletionError}</span>
                      )}
                      <div>
                        <button
                          type="button"
                          disabled={sourceDeletionState === 'deleting'}
                          onClick={() => {
                            setPendingSourceDeletion(null);
                            setSourceDeletionError(null);
                          }}
                        >
                          취소
                        </button>
                        <button
                          className="danger"
                          type="button"
                          disabled={sourceDeletionState === 'deleting'}
                          onClick={() => void confirmSourceDeletion()}
                        >
                          {sourceDeletionState === 'deleting' ? '삭제 중…' : '삭제'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <button
                  className={`source-edit-toggle ${isSourceEditing ? 'editing' : ''}`}
                  type="button"
                  onClick={() => {
                    setIsSourceEditing((value) => !value);
                    setPendingSourceDeletion(null);
                    setSourceDeletionError(null);
                  }}
                >
                  {isSourceEditing ? '완료' : '편집하기'}
                </button>
              </div>
              </aside>

              <section className="studio-graph">
                <GraphModule
                  project={activeProjectId}
                  projectName={activeProject.name}
                  reloadKey={graphReloadKey}
                  askExpansionIds={chatGraphExpansion}
                />
              </section>

              <aside className="studio-chat">
              <div className="studio-panel-head">
                <div>
                  <p className="eyebrow">AI chat</p>
                  <h2>대화</h2>
                </div>
                <button
                  className="panel-mini-button"
                  type="button"
                  aria-label="대화 내역"
                  aria-expanded={isChatMenuOpen}
                  onClick={() => {
                    setIsChatMenuOpen((open) => !open);
                    setPendingChatDeletionId(null);
                    setChatDeletionError(null);
                  }}
                >
                  ⋮
                </button>
              </div>

              {isChatMenuOpen && (
                <div className="chat-session-menu">
                  <div className="chat-session-menu-head">
                    <strong>대화 내역</strong>
                    <button type="button" onClick={startNewChat} disabled={isChatResponding}>
                      <Plus size={16} aria-hidden="true" />
                      새 대화
                    </button>
                  </div>
                  <div className="chat-session-list">
                    {chatSessions.map((session) => (
                      <div
                        className={`chat-session-item ${session.id === activeChatSessionId ? 'active' : ''}`}
                        key={session.id}
                      >
                        <button
                          className="chat-session-select"
                          type="button"
                          disabled={isChatResponding}
                          onClick={() => selectChatSession(session)}
                          title={session.title}
                        >
                          {session.title}
                        </button>
                        <button
                          className="chat-session-delete"
                          type="button"
                          aria-label={`${session.title} 삭제`}
                          disabled={isChatResponding}
                          onClick={() => {
                            setPendingChatDeletionId(session.id);
                            setChatDeletionError(null);
                          }}
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                  {pendingChatDeletionId !== null && (
                    <div className="chat-delete-confirm" role="dialog" aria-modal="true">
                      <strong>삭제하시겠습니까?</strong>
                      <p>이 대화 내역은 복구할 수 없습니다.</p>
                      {chatDeletionError !== null && <small>{chatDeletionError}</small>}
                      <div>
                        <button
                          type="button"
                          disabled={chatDeletionState === 'deleting'}
                          onClick={() => {
                            setPendingChatDeletionId(null);
                            setChatDeletionError(null);
                          }}
                        >
                          취소
                        </button>
                        <button
                          className="danger"
                          type="button"
                          disabled={chatDeletionState === 'deleting'}
                          onClick={() => void confirmChatDeletion()}
                        >
                          {chatDeletionState === 'deleting' ? '삭제 중…' : '삭제'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="studio-chat-thread">
                {chatMessages.map((message, index) => (
                  <article className={`chat-bubble ${message.role}`} key={`${message.role}-${index}`}>
                    <span>{message.role === 'assistant' ? 'SynapVox' : '나'}</span>
                    {message.role === 'assistant' && message.text ? (
                      <Suspense fallback={<p>{message.text}</p>}>
                        <AssistantMessage text={message.text} />
                      </Suspense>
                    ) : (
                      <p>{message.text || '답변 생성 중…'}</p>
                    )}
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
                  disabled={isChatResponding}
                />
                <button type="submit" disabled={isChatResponding || chatInput.trim() === ''}>→</button>
              </form>
              </aside>
            </section>
          </>
        )}
      </main>

      {authMode !== null && (
        <div className="auth-modal-backdrop" role="presentation" onMouseDown={closeAuthModal}>
          <section
            className="auth-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button className="auth-close" type="button" aria-label="닫기" onClick={closeAuthModal}>
              ×
            </button>

            <p className="eyebrow">{authMode === 'login' ? 'Welcome back' : 'Create account'}</p>
            <h2 id="auth-modal-title">
              {authMode === 'login' ? 'SynapVox에 로그인' : 'SynapVox 시작하기'}
            </h2>
            <p>
              {authMode === 'login'
                ? '녹음본과 자료를 이어서 확인하려면 로그인하세요.'
                : '녹음본과 자료를 프로젝트 단위로 정리할 계정을 만듭니다.'}
            </p>

            <form className="auth-form" onSubmit={(event) => {
              event.preventDefault();
              void submitAuth();
            }}>
              {authMode === 'signup' && (
                <label>
                  이름
                  <input
                    type="text"
                    placeholder="도원"
                    autoComplete="name"
                    value={authName}
                    onChange={(event) => setAuthName(event.target.value)}
                  />
                </label>
              )}

              <label>
                {authMode === 'login' ? '아이디 또는 이메일' : '이메일'}
                <input
                  type={authMode === 'login' ? 'text' : 'email'}
                  placeholder="you@synapvox.com"
                  autoComplete={authMode === 'login' ? 'username' : 'email'}
                  required
                  value={authEmail}
                  onChange={(event) => setAuthEmail(event.target.value)}
                />
              </label>

              <label>
                비밀번호
                <input
                  type="password"
                  value={authPassword}
                  onChange={(event) => setAuthPassword(event.target.value)}
                  placeholder="비밀번호"
                  autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                  required
                  minLength={authMode === 'signup' ? 6 : undefined}
                />
              </label>

              {authError && <p className="auth-error">{authError}</p>}

              <button className="auth-submit" type="submit" disabled={authLoading}>
                {authLoading ? '처리 중…' : authMode === 'login' ? '로그인' : '회원가입'}
              </button>

              <button
                className="auth-switch"
                type="button"
                onClick={() => {
                  setAuthEmail('');
                  setAuthPassword('');
                  setAuthName('');
                  setAuthError(null);
                  setAuthMode(authMode === 'login' ? 'signup' : 'login');
                }}
              >
                {authMode === 'login' ? '계정이 없나요? 회원가입' : '이미 계정이 있나요? 로그인'}
              </button>
            </form>
          </section>
        </div>
      )}

      {isProjectModalOpen && (
        <div className="auth-modal-backdrop" role="presentation" onMouseDown={() => setIsProjectModalOpen(false)}>
          <section
            className="auth-modal project-create-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-create-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button className="auth-close" type="button" aria-label="닫기" onClick={() => setIsProjectModalOpen(false)}>
              ×
            </button>

            <p className="eyebrow">New project</p>
            <h2 id="project-create-title">프로젝트 만들기</h2>

            <form
              className="project-create-form"
              onSubmit={(event) => {
                event.preventDefault();
                void createProject();
              }}
            >
              <label>
                제목
                <input
                  value={projectDraft.name}
                  onChange={(event) => setProjectDraft((draft) => ({ ...draft, name: event.target.value }))}
                  placeholder="예: 고객 인터뷰 정리"
                  autoFocus
                />
              </label>
              <label>
                설명
                <textarea
                  value={projectDraft.description}
                  onChange={(event) => setProjectDraft((draft) => ({ ...draft, description: event.target.value }))}
                  placeholder="이 프로젝트에 모을 녹음본과 자료를 짧게 적어주세요."
                />
              </label>
              {projectMutationError !== null && <p className="auth-error">{projectMutationError}</p>}
              <button className="auth-submit" type="submit" disabled={projectMutationState === 'saving'}>
                {projectMutationState === 'saving' ? '만드는 중…' : '만들기'}
              </button>
            </form>
          </section>
        </div>
      )}

      {pendingProjectAction !== null && (
        <div className="auth-modal-backdrop" role="presentation">
          <section
            className="auth-modal project-delete-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="project-delete-title"
          >
            <p className="eyebrow">Project</p>
            <h2 id="project-delete-title">
              {pendingProjectAction.type === 'trash'
                ? '휴지통으로 이동할까요?'
                : pendingProjectAction.type === 'permanent'
                  ? '프로젝트를 영구 삭제할까요?'
                  : '휴지통을 비울까요?'}
            </h2>
            <p>
              {pendingProjectAction.type === 'trash'
                ? '휴지통에서 다시 복원할 수 있습니다.'
                : pendingProjectAction.type === 'permanent'
                  ? '녹음본, 자료, 전사문과 지식 그래프가 함께 삭제되며 복구할 수 없습니다.'
                  : '휴지통의 모든 프로젝트와 연결된 파일 및 지식 그래프가 삭제되며 복구할 수 없습니다.'}
            </p>
            {projectMutationError !== null && <p className="auth-error">{projectMutationError}</p>}
            <div className="project-delete-actions">
              <button
                type="button"
                disabled={projectMutationState === 'deleting'}
                onClick={() => {
                  setPendingProjectAction(null);
                  setProjectMutationError(null);
                }}
              >
                취소
              </button>
              <button
                className="danger"
                type="button"
                disabled={projectMutationState === 'deleting'}
                onClick={() => void confirmProjectAction()}
              >
                {projectMutationState === 'deleting'
                  ? '처리 중…'
                  : pendingProjectAction.type === 'trash' ? '휴지통으로 이동' : '영구 삭제'}
              </button>
            </div>
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
              {sourceModalMode === 'source' ? '프로젝트 자료 추가' : '녹음 시작'}
            </h2>
            <p>
              {sourceModalMode === 'source'
                ? '이 프로젝트의 모든 녹음 전사와 AI 답변에 참고할 자료를 추가합니다.'
                : '프로젝트 자료와 이번 녹음 참고자료를 함께 사용해 전사를 진행합니다.'}
            </p>

            {sourceModalMode === 'source' ? (
              <>
                <div
                  className="source-dropzone"
                  role="button"
                  tabIndex={0}
                  onClick={() => sourceFileInputRef.current?.click()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      sourceFileInputRef.current?.click();
                    }
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const addedCount = addProjectMaterialFiles(event.dataTransfer.files);
                    if (addedCount > 0) closeSourceModal();
                  }}
                >
                  <span aria-hidden="true">+</span>
                  <strong>프로젝트 자료를 여기에 드래그하세요</strong>
                  <p>추가한 자료는 이 프로젝트의 녹음 전사와 AI 답변에 자동 참고됩니다.</p>
                </div>
                <input
                  ref={sourceFileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => {
                    const addedCount = addProjectMaterialFiles(event.target.files ?? []);
                    event.target.value = '';
                    if (addedCount > 0) closeSourceModal();
                  }}
                />
              </>
            ) : (
              <div className="record-modal-body">
                <div className="record-mode-selector" aria-label="녹음 입력 방식">
                  <button
                    className={recordInputMode === 'record' ? 'selected' : ''}
                    type="button"
                    onClick={() => changeRecordInputMode('record')}
                  >
                    <strong>직접 녹음하기</strong>
                    <span>마이크로 바로 녹음합니다.</span>
                  </button>
                  <button
                    className={recordInputMode === 'upload' ? 'selected' : ''}
                    type="button"
                    onClick={() => changeRecordInputMode('upload')}
                  >
                    <strong>녹음된 파일 올리기</strong>
                    <span>wav, mp4 같은 파일을 전사합니다.</span>
                  </button>
                </div>

                {recordInputMode === 'upload' ? (
                  <div
                    className="record-file-dropzone"
                    role="button"
                    tabIndex={0}
                    onClick={() => recordingMediaFileInputRef.current?.click()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        recordingMediaFileInputRef.current?.click();
                      }
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault();
                      selectRecordedMediaFile(event.dataTransfer.files);
                    }}
                  >
                    <span aria-hidden="true">파일</span>
                    <div>
                      <strong>녹음된 파일 업로드</strong>
                      <p>wav, mp3, m4a, webm, mp4 파일도 바로 전사할 수 있습니다.</p>
                    </div>
                  </div>
                ) : (
                  <div className="record-live-panel">
                    <div className={`record-ready-dot ${recordingState}`} aria-hidden="true" />
                    <strong>
                      {recordingState === 'recording' ? '녹음 중' : recordingState === 'ready' ? '녹음 완료' : '마이크 입력을 기다리는 중'}
                    </strong>
                  </div>
                )}
                <input
                  ref={recordingMediaFileInputRef}
                  type="file"
                  accept="audio/*,video/*,.wav,.mp3,.m4a,.aac,.ogg,.flac,.webm,.mp4,.mov"
                  hidden
                  onChange={(event) => {
                    selectRecordedMediaFile(event.target.files ?? []);
                    event.target.value = '';
                  }}
                />
                <div
                  className="record-material-dropzone"
                  role="button"
                  tabIndex={0}
                  onClick={() => recordingFileInputRef.current?.click()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      recordingFileInputRef.current?.click();
                    }
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    addRecordingMaterialFiles(event.dataTransfer.files);
                  }}
                >
                  <span aria-hidden="true">+</span>
                  <div>
                    <strong>이번 녹음 참고자료 추가</strong>
                    <p>이 녹음본 전사에만 추가로 참고됩니다.</p>
                  </div>
                </div>
                <input
                  ref={recordingFileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => {
                    addRecordingMaterialFiles(event.target.files ?? []);
                    event.target.value = '';
                  }}
                />
                {totalTranscriptionMaterialCount > 0 && (
                  <div className="record-reference-summary" aria-label="전사 참고자료">
                    <strong>전사 참고자료</strong>
                    <p>
                      프로젝트 자료 {projectMaterialCount}개
                      {' '}
                      + 이번 녹음 자료 {recordingMaterialCount}개
                    </p>
                  </div>
                )}
                {(projectMaterialSources.length > 0 || recordingAttachedMaterials.length > 0) && (
                  <div className="record-attached-list" aria-label="이 녹음본에 연결된 자료">
                    {projectMaterialSources.map((source) => (
                      <span key={source.id}>
                        <b>공통</b>
                        {source.title}
                      </span>
                    ))}
                    {recordingAttachedMaterials.map((material) => (
                      <span key={material.id}>
                        <b>이번</b>
                        {material.title}
                      </span>
                    ))}
                  </div>
                )}
                {recordingError !== null && <p className="record-error">{recordingError}</p>}
                {transcriptionError !== null && <p className="record-error">{transcriptionError}</p>}
                {recordedAudioUrl !== null && (
                  <div className="record-playback">
                    {recordedMediaKind === 'video' ? (
                      <video controls src={recordedAudioUrl}>
                        <track kind="captions" />
                      </video>
                    ) : (
                      <audio controls src={recordedAudioUrl}>
                        <track kind="captions" />
                      </audio>
                    )}
                    <a href={recordedAudioUrl} download={recordedAudioFileName ?? 'synapvox-recording.webm'}>
                      {recordedAudioFileName ?? '녹음 파일 저장'}
                    </a>
                  </div>
                )}
                {recordingState === 'ready' && transcriptionState !== 'idle' && (
                  <div className="transcription-panel">
                    <div className="transcription-steps">
                      {['준비', '전사', '완료'].map((step, index) => {
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
                          const targetRecording = sourceItems.find((source) => source.id === lastTranscribedSourceId)
                            ?? sourceItems.find((source) => source.category === '녹음본');
                          if (targetRecording !== undefined) {
                            closeSourceModal();
                            setSelectedSource(targetRecording);
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
                  {recordInputMode === 'record' && (
                    recordingState === 'recording' ? (
                      <button type="button" onClick={stopRecording}>녹음 정지</button>
                    ) : (
                      <button type="button" onClick={startRecording}>
                        {recordingState === 'ready' ? '다시 녹음' : '녹음 시작'}
                      </button>
                    )
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
                      <button type="button" onClick={() => renameSourceItem(selectedSource.id)}>이름 변경</button>
                      <button
                        className="danger"
                        type="button"
                        onClick={() => {
                          requestSourceDeletion(selectedSource);
                          setSelectedSource(null);
                          setIsSourceFullscreen(false);
                          setIsRecordingMenuOpen(false);
                        }}
                      >
                        휴지통으로 이동
                      </button>
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
                  <p>전체 노트 · {selectedSource.meta} · {selectedSource.durationLabel ?? '00:00'}</p>
                </header>

                <div className="recording-detail-grid">
                  <main className="recording-main-column">
                    <section className="recording-keywords">
                      <h3>주요 키워드</h3>
                      <div className="recording-linked-empty">
                        추출된 키워드가 없습니다.
                      </div>
                    </section>

                    <section className="recording-transcript-panel">
                      <div className="recording-section-head">
                        <h3>음성 기록</h3>
                        <div>
                          <button
                            type="button"
                            onClick={toggleTranscriptEditing}
                            disabled={selectedTranscriptSegments.length === 0}
                          >
                            {isTranscriptEditing ? '완료' : '편집'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void copyTranscriptText(selectedTranscriptSegments)}
                            disabled={selectedTranscriptSegments.length === 0}
                          >
                            {transcriptCopyState === 'copied' ? '복사됨' : '복사'}
                          </button>
                        </div>
                      </div>

                      <div className="recording-transcript-list">
                        {selectedTranscriptSegments.length > 0 ? (
                          selectedTranscriptSegments.map((segment) => (
                            <article
                              className={isTranscriptEditing ? 'editing' : ''}
                              key={`${segment.id}-${segment.time}`}
                            >
                              <span>{segment.speakerNumber}</span>
                              <div>
                                <strong>{segment.speakerLabel} <em>{segment.time}</em></strong>
                                {isTranscriptEditing ? (
                                  <textarea
                                    className="utterance-editor"
                                    value={segment.text}
                                    onChange={(event) => updateTranscriptSegmentText(selectedSource.id, segment.id, event.target.value)}
                                    aria-label={`${segment.speakerLabel} ${segment.time} 발화 편집`}
                                  />
                                ) : (
                                  <p>{segment.text}</p>
                                )}
                              </div>
                              <div className="utterance-toolbar" aria-label="발화 액션">
                                <button
                                  type="button"
                                  aria-label="복사"
                                  onClick={() => void copyTranscriptText([segment])}
                                >
                                  <svg className="utterance-icon" viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" />
                                    <path d="M14 2v5h5" />
                                  </svg>
                                </button>
                                <button type="button" aria-label="북마크">
                                  <svg className="utterance-icon" viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M7 4h10v17l-5-4-5 4z" />
                                  </svg>
                                </button>
                              </div>
                            </article>
                          ))
                        ) : (
                          <div className="recording-transcript-empty">
                            전사된 음성 기록이 없습니다.
                          </div>
                        )}
                      </div>
                    </section>
                  </main>

                  <aside className="recording-side-column">
                    <section>
                      <h3>메모 · 요약</h3>
                      <div className="recording-summary-card">
                        <strong>요약이 아직 없습니다.</strong>
                        <p>2차 전사와 요약 생성이 연결되면 이곳에 표시됩니다.</p>
                      </div>
                    </section>

                    <section>
                      <h3>연결 파일</h3>
                      {selectedSource.attachedMaterials !== undefined && selectedSource.attachedMaterials.length > 0 ? (
                        <div className="recording-linked-materials">
                          {selectedSource.attachedMaterials.map((material) => (
                            <div key={material.id}>
                              <span>{material.type}</span>
                              <strong>{material.title}</strong>
                              <small>{material.meta}</small>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="recording-linked-empty">
                          연결된 자료가 없습니다.
                        </div>
                      )}
                    </section>

                    <section>
                      <h3>연결 노드</h3>
                      <div className="recording-linked-empty">
                        연결된 그래프 노드가 없습니다.
                      </div>
                    </section>
                  </aside>
                </div>

                <div className="recording-player-bar">
                  {selectedSource.audioUrl !== undefined && (
                    selectedSource.mediaKind === 'video' ? (
                      <video
                        ref={(element) => { detailAudioRef.current = element; }}
                        src={selectedSource.audioUrl}
                        onTimeUpdate={(event) => setDetailAudioTimeLabel(formatTranscriptTime(event.currentTarget.currentTime))}
                        onPause={() => setIsDetailAudioPlaying(false)}
                        onPlay={() => setIsDetailAudioPlaying(true)}
                        onEnded={() => {
                          setIsDetailAudioPlaying(false);
                          setDetailAudioTimeLabel('00:00');
                        }}
                      >
                        <track kind="captions" />
                      </video>
                    ) : (
                      <audio
                        ref={(element) => { detailAudioRef.current = element; }}
                        src={selectedSource.audioUrl}
                        onTimeUpdate={(event) => setDetailAudioTimeLabel(formatTranscriptTime(event.currentTarget.currentTime))}
                        onPause={() => setIsDetailAudioPlaying(false)}
                        onPlay={() => setIsDetailAudioPlaying(true)}
                        onEnded={() => {
                          setIsDetailAudioPlaying(false);
                          setDetailAudioTimeLabel('00:00');
                        }}
                      >
                        <track kind="captions" />
                      </audio>
                    )
                  )}
                  <span>{detailAudioTimeLabel}</span>
                  <button type="button">↺5</button>
                  <button
                    className="play"
                    type="button"
                    aria-label={isDetailAudioPlaying ? '일시정지' : '재생'}
                    disabled={selectedSource.audioUrl === undefined}
                    onClick={toggleDetailAudio}
                  >
                    {isDetailAudioPlaying ? 'Ⅱ' : '▶'}
                  </button>
                  <button type="button">5↻</button>
                  <span>{selectedSource.durationLabel ?? '00:00'}</span>
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

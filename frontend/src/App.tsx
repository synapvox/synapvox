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
  id: string;
  title: string;
  type: string;
  category: string;
  meta: string;
  updatedOrder: number;
  audioUrl?: string;
  durationLabel?: string;
  attachedMaterials?: SourceItem[];
  mediaKind?: 'audio' | 'video';
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

const initialProjects: Project[] = [];

const statusFilters = ['전체', '분석 중', '요약 완료', '자료 필요'];
const homeSections = ['노트북', '즐겨찾기', '공유됨', '휴지통'];
const projectSortOptions = ['최근 수정순', '이름순', '녹음 많은 순'];
const initialSourceItems: SourceItem[] = [];
const sourceTabs = ['녹음본', '자료'] as const;
const sourceSortOptions = ['최신순', '오래된순', '글자순', '종류순'] as const;

type GraphNode = {
  id: string; type: 'session' | 'concept'; label: string;
  detail?: string; seq?: number; x: number; y: number; r?: number;
};
type GraphLink = { from: string; to: string; rel: string; label: string };

const initialGraphNodes: GraphNode[] = [];
const initialGraphLinks: GraphLink[] = [];

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const graphRelationClass: Record<string, 'mentions' | 'cooccur' | 'next' | 'continues' | 'expands'> = {
  SESSION_MENTIONS_CONCEPT: 'mentions',
  CONCEPT_CO_OCCURS_WITH: 'cooccur',
  NEXT_SESSION: 'next',
  CONTINUES: 'continues',
  EXPANDS: 'expands',
};
const semanticRelations = new Set(['CONTINUES', 'EXPANDS']);

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

function App() {
  const [projects, setProjects] = useState(initialProjects);
  const [sourceItems, setSourceItems] = useState(initialSourceItems);
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
  const [isProjectModalOpen, setIsProjectModalOpen] = useState(false);
  const [projectDraft, setProjectDraft] = useState({
    name: '',
    description: '',
  });
  const [isProjectTitleEditing, setIsProjectTitleEditing] = useState(false);
  const [isSourceEditing, setIsSourceEditing] = useState(false);
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
  const [chatMessages, setChatMessages] = useState([
    {
      role: 'assistant',
      text: '프로젝트의 녹음본과 자료를 바탕으로 질문에 답변합니다. 궁금한 내용을 입력하면 가운데 그래프에서 관련 노드를 함께 표시할게요.',
    },
  ]);
  const [graphFocusNodeIds, setGraphFocusNodeIds] = useState<string[]>([]);
  const [graphViewport, setGraphViewport] = useState({ x: 0, y: 0, scale: 1 });
  const [graphFilter, setGraphFilter] = useState({
    mentions: true,
    cooccur: false,   // 개념-개념 동시출현 엣지는 밀도가 높아 기본 off(필터로 켤 수 있음)
    next: true,
    semantic: true,
    sessionsOnly: false,
  });
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(null);
  const [graphNodes] = useState<GraphNode[]>(initialGraphNodes);
  const [graphLinks] = useState<GraphLink[]>(initialGraphLinks);
  const getGraphNode = (id: string) => graphNodes.find((node) => node.id === id);
  const [isDetailAudioPlaying, setIsDetailAudioPlaying] = useState(false);
  const [detailAudioTimeLabel, setDetailAudioTimeLabel] = useState('00:00');
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
  const recordingStartedAtRef = useRef<number | null>(null);
  const savedAudioUrlsRef = useRef(new Set<string>());
  const detailAudioRef = useRef<HTMLAudioElement | HTMLVideoElement | null>(null);
  const sourceFileInputRef = useRef<HTMLInputElement | null>(null);
  const recordingFileInputRef = useRef<HTMLInputElement | null>(null);
  const recordingMediaFileInputRef = useRef<HTMLInputElement | null>(null);

  const activeProject = activeProjectIndex === null ? null : projects[activeProjectIndex];
  const visibleSourceItems = sourceItems
    .filter((source) => source.category === sourceTab)
    .sort((a, b) => {
      if (sourceSort === '오래된순') return b.updatedOrder - a.updatedOrder;
      if (sourceSort === '글자순') return a.title.localeCompare(b.title);
      if (sourceSort === '종류순') return a.category.localeCompare(b.category) || a.updatedOrder - b.updatedOrder;
      return a.updatedOrder - b.updatedOrder;
    });
  const visibleGraphNodeIds = new Set<string>();
  if (graphFilter.sessionsOnly) {
    graphNodes
      .filter((node) => node.type === 'session')
      .forEach((node) => visibleGraphNodeIds.add(node.id));
  } else {
    const focusSeedIds = graphFocusNodeIds.length > 0
      ? graphFocusNodeIds
      : selectedGraphNodeId === null
        ? []
        : [selectedGraphNodeId];

    graphNodes
      .filter((node) => node.type === 'session')
      .forEach((node) => visibleGraphNodeIds.add(node.id));

    focusSeedIds.forEach((id) => visibleGraphNodeIds.add(id));

    graphLinks.forEach((link) => {
      if (focusSeedIds.includes(link.from) || focusSeedIds.includes(link.to)) {
        visibleGraphNodeIds.add(link.from);
        visibleGraphNodeIds.add(link.to);
      }
    });

    if (focusSeedIds.length === 0) {
      graphNodes.slice(0, 24).forEach((node) => visibleGraphNodeIds.add(node.id));
    }
  }
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
  const selectedTranscriptSegments = selectedSource === null
    ? []
    : transcriptsBySourceId[selectedSource.id] ?? [];
  const profileProjectCount = projects.filter((project) => !project.trashed).length;
  const profileRecordingCount = sourceItems.filter((source) => source.category === '녹음본').length;
  const profileMaterialCount = sourceItems.filter((source) => source.category === '자료').length;

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
    setIsProfileOpen(false);
    setIsHelpOpen(false);
    setIsSettingsOpen(false);
    setIsAccountMenuOpen(false);
    setActiveProjectIndex(index);
    window.history.pushState({ view: 'project', projectIndex: index }, '', window.location.pathname);
  };

  const openProjectHome = () => {
    setIsProfileOpen(false);
    setIsHelpOpen(false);
    setIsSettingsOpen(false);
    setIsAccountMenuOpen(false);
    setActiveProjectIndex(null);
    setHomeSection('노트북');
    window.history.pushState({ view: 'home' }, '', window.location.pathname);
  };

  const openProfile = () => {
    setIsProfileOpen(true);
    setIsHelpOpen(false);
    setIsSettingsOpen(false);
    setIsAccountMenuOpen(false);
    setActiveProjectIndex(null);
    window.history.pushState({ view: 'profile' }, '', window.location.pathname);
  };

  const logout = () => {
    setIsLoggedIn(false);
    setIsProfileOpen(false);
    setIsAccountMenuOpen(false);
    setAuthMode(null);
  };

  const completeAuth = () => {
    setIsLoggedIn(true);
    setIsAccountMenuOpen(false);
    setAuthMode(null);
  };

  const openCreateProjectModal = () => {
    const existingNewProjectCount = projects.filter((project) => project.name.startsWith('새 프로젝트')).length;
    const projectName = existingNewProjectCount === 0 ? '새 프로젝트' : `새 프로젝트 ${existingNewProjectCount + 1}`;
    setProjectDraft({
      name: projectName,
      description: '',
    });
    setIsProjectModalOpen(true);
  };

  const createProject = () => {
    const name = projectDraft.name.trim() || '새 프로젝트';
    const description = projectDraft.description.trim() || '녹음본과 자료를 묶을 새 작업 공간';
    const nextProject: Project = {
      name,
      description,
      updatedAt: '방금',
      recordings: 0,
      materials: 0,
      status: '자료 필요',
    };

    setProjects((currentProjects) => [nextProject, ...currentProjects]);
    setIsProjectModalOpen(false);
    setIsProfileOpen(false);
    setIsHelpOpen(false);
    setIsSettingsOpen(false);
    setHomeSection('노트북');
    setStatusFilter('전체');
    setProjectQuery('');
    setActiveProjectIndex(0);
    window.history.pushState({ view: 'project', projectIndex: 0 }, '', window.location.pathname);
  };

  const startProjectEditing = () => {
    if (activeProject === null) return;
    setProjectEditDraft({
      name: activeProject.name,
      description: activeProject.description,
    });
    setIsProjectTitleEditing(true);
  };

  const saveProjectEdits = () => {
    if (activeProjectIndex === null) return;
    const name = projectEditDraft.name.trim() || activeProject?.name || '새 프로젝트';
    const description = projectEditDraft.description.trim() || '녹음본과 자료를 묶을 작업 공간';
    setProjects((currentProjects) => currentProjects.map((project, projectIndex) => (
      projectIndex === activeProjectIndex
        ? { ...project, name, description, updatedAt: '방금' }
        : project
    )));
    setIsProjectTitleEditing(false);
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

  const removeSourceItem = (sourceId: string) => {
    const targetSource = sourceItems.find((source) => source.id === sourceId);
    if (targetSource?.audioUrl !== undefined) {
      savedAudioUrlsRef.current.delete(targetSource.audioUrl);
      URL.revokeObjectURL(targetSource.audioUrl);
    }
    setSourceItems((currentSourceItems) => currentSourceItems.filter((source) => source.id !== sourceId));
    if (targetSource !== undefined && activeProjectIndex !== null) {
      setProjects((currentProjects) => currentProjects.map((project, projectIndex) => {
        if (projectIndex !== activeProjectIndex) return project;
        if (targetSource.category === '녹음본') {
          return { ...project, recordings: Math.max(0, project.recordings - 1), updatedAt: '방금' };
        }
        return { ...project, materials: Math.max(0, project.materials - 1), updatedAt: '방금' };
      }));
    }
    setTranscriptsBySourceId((currentTranscripts) => {
      const nextTranscripts = { ...currentTranscripts };
      delete nextTranscripts[sourceId];
      return nextTranscripts;
    });
    if (selectedSource?.id === sourceId) {
      setSelectedSource(null);
      setIsSourceFullscreen(false);
    }
    if (lastTranscribedSourceId === sourceId) setLastTranscribedSourceId(null);
  };

  const renameSourceItem = (sourceId: string) => {
    const targetSource = sourceItems.find((source) => source.id === sourceId);
    if (targetSource === undefined) return;
    const nextTitle = window.prompt('녹음본 이름을 입력하세요.', targetSource.title)?.trim();
    if (!nextTitle) return;

    setSourceItems((currentSourceItems) => currentSourceItems.map((source) => (
      source.id === sourceId ? { ...source, title: nextTitle, meta: source.meta.replace(/^이름 변경 전 · /, '') } : source
    )));
    setSelectedSource((currentSource) => (
      currentSource?.id === sourceId ? { ...currentSource, title: nextTitle } : currentSource
    ));
    setIsRecordingMenuOpen(false);
  };

  const createMaterialItems = (files: FileList | File[], prefix = 'material') => {
    const fileList = Array.from(files).filter((file) => file.size > 0 || file.name.trim().length > 0);
    if (fileList.length === 0) return [];

    const now = Date.now();
    return fileList.map((file, index): SourceItem => ({
      id: `${prefix}-${now}-${index}`,
      title: file.name,
      type: getMaterialSourceType(file),
      category: '자료',
      meta: `자료 · ${formatFileSize(file.size)}`,
      updatedOrder: index,
    }));
  };

  const addProjectMaterialFiles = (files: FileList | File[]) => {
    const nextMaterials = createMaterialItems(files, 'material');
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

    return nextMaterials.length;
  };

  const addRecordingMaterialFiles = (files: FileList | File[]) => {
    const fileList = Array.from(files).filter((file) => file.size > 0 || file.name.trim().length > 0);
    const nextMaterials = createMaterialItems(fileList, 'recording-material');
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

  const resetRecordedMedia = () => {
    isClosingRecordingRef.current = true;
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    recordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    recordingStreamRef.current = null;
    mediaRecorderRef.current = null;
    recordingChunksRef.current = [];
    recordingStartedAtRef.current = null;
    if (recordedAudioUrl !== null && !savedAudioUrlsRef.current.has(recordedAudioUrl)) {
      URL.revokeObjectURL(recordedAudioUrl);
    }
    setRecordedAudioUrl(null);
    setRecordedAudioBlob(null);
    setRecordedAudioFileName(null);
    setRecordedAudioDurationLabel('00:00');
    setRecordedMediaKind('audio');
    setRecordingState('idle');
    setRecordingError(null);
    setTranscriptionError(null);
    setTranscriptionState('idle');
    setTranscriptionStep(0);
  };

  const changeRecordInputMode = (mode: 'record' | 'upload') => {
    if (recordInputMode === mode) return;
    resetRecordedMedia();
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
    if (recordedAudioBlob === null) {
      setTranscriptionError('전사할 녹음 파일이 없습니다.');
      return;
    }

    setTranscriptionError(null);
    setTranscriptionState('transcribing');
    setTranscriptionStep(1);

    const body = new FormData();
    body.append('audio', recordedAudioBlob, recordedAudioFileName ?? `synapvox-recording-${Date.now()}.webm`);
    recordingMaterialFiles.forEach((file) => {
      body.append('materials', file, file.name);
    });
    body.append('project_id', activeProject?.name ?? 'local-project');
    body.append('meeting_id', `meeting-${Date.now()}`);

    try {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      setTranscriptionStep(2);
      const response = await fetch('/api/stt/transcribe', {
        method: 'POST',
        body,
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => null) as { detail?: string } | null;
        throw new Error(errorBody?.detail ?? '전사 요청에 실패했습니다.');
      }

      setTranscriptionStep(3);
      const result = await response.json() as IntermediateTranscript;
      const transcriptSegments = mapIntermediateTranscript(result);
      const savedTranscriptSegments = transcriptSegments;
      const now = new Date();
      const timeLabel = now.toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const recordingId = `recording-${now.getTime()}`;
      const savedRecording: SourceItem = {
        id: recordingId,
        title: getRecordingTitle(recordedAudioFileName, `녹음본 ${timeLabel}`),
        type: recordedAudioFileName === null ? '녹음' : '파일',
        category: '녹음본',
        meta: `전사 완료 · 오늘 ${timeLabel}${recordingAttachedMaterials.length > 0 ? ` · 연결 자료 ${recordingAttachedMaterials.length}개` : ''}`,
        updatedOrder: 0,
        audioUrl: recordedAudioUrl ?? undefined,
        durationLabel: recordedAudioDurationLabel,
        attachedMaterials: recordingAttachedMaterials,
        mediaKind: recordedMediaKind,
      };
      if (recordedAudioUrl !== null) savedAudioUrlsRef.current.add(recordedAudioUrl);
      setSourceItems((currentSourceItems) => [
        savedRecording,
        ...currentSourceItems.map((source) => ({ ...source, updatedOrder: source.updatedOrder + 1 })),
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
      setTranscriptionStep(4);
    } catch (error) {
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

    const hasRecordings = sourceItems.some((source) => source.category === '녹음본');
    const hasMaterials = sourceItems.some((source) => source.category === '자료');
    const hasGraph = graphNodes.length > 0;
    const assistantText = hasRecordings || hasMaterials
      ? '추가된 녹음본과 자료를 기준으로 답변을 준비하고 있습니다. 관련 근거가 만들어지면 이 대화와 가운데 그래프에 함께 표시됩니다.'
      : '아직 참고할 녹음본이나 자료가 없습니다. 먼저 녹음본을 전사하거나 자료를 추가하면, 그 내용을 바탕으로 질문에 답할 수 있습니다.';

    setChatMessages((currentMessages) => [
      ...currentMessages,
      { role: 'user', text: query },
      {
        role: 'assistant',
        text: assistantText,
      },
    ]);
    setChatInput('');
    if (hasGraph) {
      setSelectedGraphNodeId(graphNodes[0]?.id ?? null);
      setGraphFocusNodeIds(graphNodes.slice(0, 4).map((node) => node.id));
      setGraphViewport({ x: -40, y: 12, scale: 1.12 });
    }
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
                <span className="avatar">도</span>
                <span>
                  <strong>도원</strong>
                  <small>내 정보</small>
                </span>
              </button>

              {isAccountMenuOpen && (
                <div className="account-menu">
                  <button type="button" onClick={openProfile}>내 정보 보기</button>
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

              {isLoggedIn ? (
                <div className="account-menu-wrap topbar-account-menu">
                  <button
                    className="topbar-avatar"
                    type="button"
                    aria-label="내 정보"
                    aria-expanded={isAccountMenuOpen}
                    onClick={() => setIsAccountMenuOpen((value) => !value)}
                  >
                    도
                  </button>
                  {isAccountMenuOpen && (
                    <div className="account-menu">
                      <button type="button" onClick={openProfile}>내 정보 보기</button>
                      <button className="danger" type="button" onClick={logout}>로그아웃</button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="account-menu-wrap topbar-account-menu">
                  <button
                    className="topbar-icon-button"
                    type="button"
                    aria-label="계정 메뉴"
                    aria-expanded={isAccountMenuOpen}
                    onClick={() => setIsAccountMenuOpen((value) => !value)}
                  >
                    <svg className="person-icon" viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="12" cy="8" r="4" />
                      <path d="M4.5 20c1.6-4.2 4-6.3 7.5-6.3s5.9 2.1 7.5 6.3" />
                    </svg>
                  </button>
                  {isAccountMenuOpen && (
                    <div className="account-menu">
                      <button
                        type="button"
                        onClick={() => {
                          setAuthMode('login');
                          setIsAccountMenuOpen(false);
                        }}
                      >
                        로그인
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAuthMode('signup');
                          setIsAccountMenuOpen(false);
                        }}
                      >
                        회원가입
                      </button>
                    </div>
                  )}
                </div>
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
                  <span className="profile-avatar-large">도</span>
                  <div>
                    <h2>도원</h2>
                    <p>로컬 작업 공간 계정</p>
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
                <p>현재 화면의 프로젝트와 소스는 프론트 상태에 보관됩니다. 백엔드 저장소가 연결되면 계정별로 분리됩니다.</p>
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
                <button className="new-project-card" type="button" onClick={openCreateProjectModal}>
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
                    saveProjectEdits();
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
                        if (event.key === 'Enter') saveProjectEdits();
                      }}
                      autoFocus
                    />
                    <input
                      className="project-description-input"
                      value={projectEditDraft.description}
                      onChange={(event) => setProjectEditDraft((draft) => ({ ...draft, description: event.target.value }))}
                      placeholder="프로젝트 설명"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') saveProjectEdits();
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
                  <button className="source-primary-button" type="button" onClick={() => setSourceModalMode('source')}>+ 자료 추가</button>
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
                          onClick={() => removeSourceItem(source.id)}
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

                <button
                  className={`source-edit-toggle ${isSourceEditing ? 'editing' : ''}`}
                  type="button"
                  onClick={() => setIsSourceEditing((value) => !value)}
                >
                  {isSourceEditing ? '완료' : '편집하기'}
                </button>
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
                {graphNodes.length === 0 && (
                  <div className="graph-empty-state">
                    <strong>아직 연결된 그래프가 없습니다.</strong>
                    <span>녹음본을 전사한 뒤 그래프 생성이 연결되면 여기에 표시됩니다.</span>
                  </div>
                )}
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
                        const isFocused = true;
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
                        const isFocused = true;

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
                ? '녹음본과 자료를 이어서 확인하려면 로그인하세요.'
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
                createProject();
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
              <button className="auth-submit" type="submit">만들기</button>
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
              {sourceModalMode === 'source' ? '자료 추가' : '녹음 시작'}
            </h2>
            <p>
              {sourceModalMode === 'source'
                ? '파일을 추가하면 자료 소스 카드에 표시됩니다.'
                : '녹음에 참고할 파일을 함께 넣고 전사, 요약, 그래프 연결을 진행합니다.'}
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
                  <strong>파일을 여기에 드래그하세요</strong>
                  <p>추가하면 자료 소스 카드에 바로 들어갑니다.</p>
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
                    <strong>녹음 참고 파일 추가</strong>
                    <p>자료 카드에 표시되고, 전사 후 녹음본 상세에서도 보입니다.</p>
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
                {recordingAttachedMaterials.length > 0 && (
                  <div className="record-attached-list" aria-label="이 녹음본에 연결된 자료">
                    {recordingAttachedMaterials.map((material) => (
                      <span key={material.id}>
                        <b>{material.type}</b>
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
                          removeSourceItem(selectedSource.id);
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
                            onClick={() => setIsTranscriptEditing((value) => !value)}
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

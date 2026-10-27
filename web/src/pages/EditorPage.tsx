// 큐시트 에디터: Act 별 가로 타임라인 + 드래그 정렬 + 인스펙터 + JSON 내보내기/가져오기
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { parseNote, setImportant } from '@shared/note';
import { formatAtemAction, parseAtemAction, type AtemAction } from '@shared/atemAction';
import { cueDurationMs, cueTimecodes } from '@shared/engine';
import { defaultIdGen, ops } from '@shared/editorOps';
import { formatZodError, serviceInputSchema } from '@shared/schema';
import { ADVANCE_MODES, MAX_CAMERA, SECTION_PRESETS, SHOT_SIZES, type Act, type Cue, type Service, type ServiceSummary } from '@shared/types';
import { TopBar } from '../components/TopBar';
import type { SwitcherCaps } from '@shared/protocol';
import { ApiError, api, openLive } from '../lib/api';
import { MODE_LABEL, SHOT_LABEL, cameraColor, formatClock } from '../lib/format';
import { useShow } from '../lib/useShow';
import './editor.css';

const CAMERAS = Array.from({ length: MAX_CAMERA }, (_, i) => i + 1);
const UNKNOWN_WIDTH = 120;
const MIN_WIDTH = 76;

const SECTION_COLORS: Record<string, string> = {
  INTRO: '#6b7280',
  V: '#3b82f6',
  PRE: '#a855f7',
  CH: '#ef4444',
  BR: '#f97316',
  INST: '#14b8a6',
  TAG: '#eab308',
  OUTRO: '#0ea5e9',
};
const sectionColor = (s: string) => SECTION_COLORS[s] ?? SECTION_COLORS[s.replace(/\d+$/, '')] ?? '#6b7280';

/** 되돌리기 기록 최대 수 */
const HISTORY_LIMIT = 100;
/** 같은 칸을 이 시간(ms) 안에 이어서 고치면 되돌리기 한 번으로 묶는다 (글자 하나씩 되돌리지 않도록) */
const COALESCE_MS = 1000;

/** 현재 스위처에서 이 큐가 적힌 대로 실행되지 않는 이유. 문제없으면 null */
export function cueProblem(cue: Cue, caps: SwitcherCaps | undefined): string | null {
  if (!caps) return null;
  if (caps.cameras && !caps.cameras.includes(cue.camera)) return `CAM ${cue.camera} 은(는) 현재 스위처 설정에 컷 출력이 없습니다 — GO 해도 컷이 나가지 않음`;
  const a = parseAtemAction(cue.atemAction);
  if (a?.kind === 'auto' && !caps.transition) return 'AUTO(트랜지션)를 지원하지 않는 스위처 — 하드 컷으로 나갑니다';
  if (a?.kind === 'macro' && !caps.macro) return '매크로를 지원하지 않는 스위처 — 컷만 나가고 매크로는 실패';
  if (a?.kind === 'dsk' && !caps.dsk) return 'DSK 를 지원하지 않는 스위처 — 컷만 나가고 DSK 는 실패';
  return null;
}

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

interface Selection {
  actId: string;
  cueId: string;
}

export function EditorPage() {
  const { id } = useParams();
  return id ? <ServiceEditor key={id} serviceId={id} /> : <ServicePicker />;
}

function ServicePicker() {
  const [list, setList] = useState<ServiceSummary[]>([]);
  useEffect(() => {
    api.listServices().then(setList);
  }, []);
  return (
    <>
      <TopBar />
      <main className="home">
        <section>
          <h2>편집할 행사 선택</h2>
          {list.map((s) => (
            <div key={s.id} style={{ padding: '6px 0' }}>
              <Link to={`/editor/${s.id}`}>
                {s.date} {s.title}
              </Link>
            </div>
          ))}
          {list.length === 0 && <p className="muted">행사가 없습니다. 홈에서 새로 만드세요.</p>}
        </section>
      </main>
    </>
  );
}

function ServiceEditor({ serviceId }: { serviceId: string }) {
  const navigate = useNavigate();
  const live = useShow('editor');
  const [doc, setDoc] = useState<Service | null>(null);
  const [saved, setSaved] = useState<Service | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  /** Ctrl/Shift+클릭으로 여러 개 고른 큐 id (2개 이상이면 일괄 편집) */
  const [multi, setMulti] = useState<Set<string>>(new Set());
  const selectCue = (actId: string, cueId: string, additive: boolean) => {
    if (additive) {
      setMulti((m) => {
        const n = new Set(m.size === 0 && sel ? [sel.cueId] : m);
        if (n.has(cueId)) n.delete(cueId);
        else n.add(cueId);
        return n;
      });
    } else setMulti(new Set());
    setSel({ actId, cueId });
  };
  const bulk = multi.size > 1;
  const [pxPerSec, setPxPerSec] = useState(8);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [past, setPast] = useState<Service[]>([]);
  const [future, setFuture] = useState<Service[]>([]);
  const [importingActs, setImportingActs] = useState(false);
  const lastChange = useRef<{ key: string; at: number } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const caps = live.snapshot?.switcherCaps;

  /** 편집 반영 + 되돌리기 기록. key 가 같고 1초 안이면 직전 기록에 합침 (글자 입력) */
  const change = (next: Service, key?: string) => {
    if (!doc) return;
    const t = Date.now();
    const merge = key && lastChange.current?.key === key && t - lastChange.current.at < COALESCE_MS;
    if (!merge) setPast((p) => [...p.slice(-(HISTORY_LIMIT - 1)), doc]);
    lastChange.current = key ? { key, at: t } : null;
    setFuture([]);
    setDoc(next);
  };
  const undo = () => {
    if (!doc || past.length === 0) return;
    setFuture((f) => [doc, ...f].slice(0, HISTORY_LIMIT));
    setDoc(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
    lastChange.current = null;
  };
  const redo = () => {
    if (!doc || future.length === 0) return;
    setPast((p) => [...p, doc].slice(-HISTORY_LIMIT));
    setDoc(future[0]);
    setFuture((f) => f.slice(1));
    lastChange.current = null;
  };

  useEffect(() => {
    api
      .getService(serviceId)
      .then((s) => {
        setDoc(s);
        setSaved(s);
      })
      .catch((e) => setMessage({ kind: 'err', text: e.message }));
  }, [serviceId]);

  const dirty = useMemo(() => doc !== null && JSON.stringify(doc) !== JSON.stringify(saved), [doc, saved]);
  const isLive = live.snapshot?.serviceId === serviceId;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = useCallback(async () => {
    if (!doc) return;
    const parsed = serviceInputSchema.safeParse(doc);
    if (!parsed.success) return setMessage({ kind: 'err', text: formatZodError(parsed.error) });
    setSaving(true);
    try {
      let s: Service;
      try {
        s = await api.saveService(serviceId, doc, saved?.updatedAt);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409)) throw e;
        // 그 사이 다른 PC·탭에서 먼저 저장함
        if (confirm(`${e.message}\n\n[확인] 내 내용으로 덮어쓰기\n[취소] 최신 내용 불러오기 (지금 고친 내용은 버림)`)) {
          s = await api.saveService(serviceId, doc);
        } else {
          s = await api.getService(serviceId);
          setPast([]);
          setFuture([]);
          setDoc(s);
          setSaved(s);
          setMessage({ kind: 'ok', text: '최신 내용을 불러왔습니다' });
          return;
        }
      }
      setDoc(s);
      setSaved(s);
      setMessage({ kind: 'ok', text: isLive ? '저장됨 — 라이브에 즉시 반영' : '저장됨' });
    } catch (e) {
      setMessage({ kind: 'err', text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }, [doc, saved, serviceId, isLive]);

  // 선택 위치 계산
  const pos = useMemo(() => {
    if (!doc || !sel) return null;
    const a = doc.acts.findIndex((x) => x.id === sel.actId);
    const c = a >= 0 ? doc.acts[a].cues.findIndex((x) => x.id === sel.cueId) : -1;
    return a >= 0 && c >= 0 ? { a, c } : null;
  }, [doc, sel]);

  // 단축키: Ctrl/Cmd+S 저장, Delete 삭제, Alt+←/→ 큐 이동, Ctrl/Cmd+D 복제
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
        return;
      }
      // 되돌리기 (입력 칸 안에서는 브라우저 기본 되돌리기)
      if ((e.ctrlKey || e.metaKey) && !isTyping(e.target)) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) {
          e.preventDefault();
          return undo();
        }
        if ((k === 'z' && e.shiftKey) || k === 'y') {
          e.preventDefault();
          return redo();
        }
      }
      if (doc && bulk && e.key === 'Delete' && !isTyping(e.target)) {
        change(ops.deleteCues(doc, multi));
        setMessage({ kind: 'ok', text: `큐 ${multi.size}개를 삭제했습니다 — Ctrl+Z 로 되돌리기` });
        setMulti(new Set());
        setSel(null);
        return;
      }
      if (e.key === 'Escape' && bulk) return setMulti(new Set());
      if (!doc || !pos || isTyping(e.target)) return;
      if (e.key === 'Delete') {
        change(ops.deleteCue(doc, pos.a, pos.c));
        setSel(null);
        setMessage({ kind: 'ok', text: '큐를 삭제했습니다 — Ctrl+Z 로 되돌리기' });
      } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        change(ops.moveCue(doc, pos.a, pos.c, pos.c + (e.key === 'ArrowLeft' ? -1 : 1)));
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const next = ops.duplicateCue(doc, pos.a, pos.c, defaultIdGen);
        change(next);
        setSel({ actId: sel!.actId, cueId: next.acts[pos.a].cues[pos.c + 1].id });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const importJson = async (file: File) => {
    try {
      const s = await api.importService(JSON.parse(await file.text()));
      navigate(`/editor/${s.id}`);
      setMessage({ kind: 'ok', text: `"${s.title}" 을(를) 새 행사로 가져왔습니다` });
    } catch (e) {
      setMessage({ kind: 'err', text: `가져오기 실패: ${(e as Error).message}` });
    }
  };

  const fillDurations = async () => {
    if (!doc) return;
    try {
      const measured = await api.measured();
      const known = Object.keys(measured).length;
      if (known === 0) return setMessage({ kind: 'err', text: '측정된 시간이 없습니다 — 디렉터에서 리허설 모드로 GO 하며 한 번 진행해 보세요' });
      const overwrite = confirm('이미 길이가 적힌 큐도 측정값으로 바꿀까요?\n[확인] 모두 바꾸기   [취소] 비어 있는 큐만 채우기');
      const r = ops.fillDurations(doc, measured, overwrite);
      if (r.changed === 0) return setMessage({ kind: 'ok', text: '바꿀 큐가 없습니다 (MANUAL 순서의 측정된 큐만 대상)' });
      change(r.service);
      setMessage({ kind: 'ok', text: `큐 ${r.changed}개의 길이를 채웠습니다 — 확인 후 저장하세요 (Ctrl+Z 로 되돌리기)` });
    } catch (e) {
      setMessage({ kind: 'err', text: (e as Error).message });
    }
  };

  const remove = async () => {
    if (!doc || !confirm(`"${doc.title}" 행사를 삭제할까요? 되돌릴 수 없습니다.`)) return;
    await api.deleteService(serviceId);
    navigate('/');
  };

  const goLive = async () => {
    if (dirty && !confirm('저장하지 않은 변경이 있습니다. 저장된 버전으로 라이브를 열까요?')) return;
    try {
      if (await openLive(serviceId)) navigate('/director');
    } catch (e) {
      setMessage({ kind: 'err', text: (e as Error).message });
    }
  };

  if (!doc) {
    return (
      <>
        <TopBar />
        <p className="muted" style={{ padding: 16 }}>
          {message?.text ?? '불러오는 중…'}
        </p>
      </>
    );
  }

  const problems = doc.acts.flatMap((a) => a.cues.filter((c) => cueProblem(c, caps)));
  const liveCueId = isLive && live.service ? live.service.acts[live.snapshot!.state.actIndex]?.cues[live.snapshot!.state.cueIndex]?.id : undefined;

  return (
    <div className="editor">
      <TopBar>
        {isLive && <span className="badge" style={{ borderColor: 'var(--pgm)', color: '#fca5a5' }}>● 라이브 중인 행사</span>}
        {dirty && <span className="badge" style={{ borderColor: 'var(--hold)' }}>저장 안 됨</span>}
        {problems.length > 0 && (
          <span className="badge" style={{ borderColor: 'var(--pgm)', color: '#fca5a5' }} title="큐 블록의 ⚠ 표시를 눌러 확인">
            ⚠ 현재 스위처에서 그대로 실행되지 않는 큐 {problems.length}개
          </span>
        )}
      </TopBar>

      <div className="editor-toolbar">
        <input className="title-input" value={doc.title} onChange={(e) => change(ops.updateService(doc, { title: e.target.value }), 'title')} />
        <input type="date" value={doc.date ?? ''} onChange={(e) => change(ops.updateService(doc, { date: e.target.value || null }))} />
        <button className="primary" onClick={save} disabled={!dirty || saving} title="Ctrl+S">
          {saving ? '저장 중…' : '저장'}
        </button>
        <button onClick={undo} disabled={past.length === 0} title="되돌리기 (Ctrl+Z)">
          ↶
        </button>
        <button onClick={redo} disabled={future.length === 0} title="다시 하기 (Ctrl+Shift+Z / Ctrl+Y)">
          ↷
        </button>
        <span className="spacer" />
        <label className="row muted" title="타임라인 확대/축소">
          줌
          <input type="range" min={2} max={30} value={pxPerSec} onChange={(e) => setPxPerSec(Number(e.target.value))} />
        </label>
        <a href={api.exportUrl(serviceId)} download>
          <button disabled={dirty} title={dirty ? '먼저 저장하세요' : '저장된 내용을 JSON 으로 내려받기'}>
            JSON 내보내기
          </button>
        </a>
        <button onClick={fillDurations} title="리허설·지난 진행에서 GO 사이 실제 걸린 시간으로 MANUAL 순서의 큐 길이를 채웁니다 (≈ 카운트다운이 정확해짐)">
          측정 시간으로 길이 채우기
        </button>
        <a href={`/print/${serviceId}`} target="_blank" rel="noreferrer">
          <button disabled={dirty} title={dirty ? '먼저 저장하세요' : '카메라별 종이 큐시트 (비상용) — 인쇄/PDF'}>
            카메라별 인쇄
          </button>
        </a>
        <button onClick={() => setImportingActs(true)} title="다른 행사의 순서(찬양 곡 등)를 큐째로 복사해 와서 끝에 붙입니다">
          다른 행사에서 순서 가져오기
        </button>
        <button onClick={() => importRef.current?.click()}>JSON 가져오기</button>
        <input
          ref={importRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importJson(f);
            e.target.value = '';
          }}
        />
        <button onClick={goLive}>라이브로 열기</button>
        <button className="danger" onClick={remove}>
          삭제
        </button>
      </div>
      {importingActs && (
        <ActImporter
          currentId={serviceId}
          onClose={() => setImportingActs(false)}
          onImport={(acts) => {
            change({ ...doc, acts: [...doc.acts, ...acts] });
            setImportingActs(false);
            setMessage({ kind: 'ok', text: `순서 ${acts.length}개를 끝에 붙였습니다 (저장해야 반영)` });
          }}
        />
      )}
      {message && (
        <div className={`editor-msg ${message.kind}`} onClick={() => setMessage(null)}>
          {message.text}
        </div>
      )}

      <div className="editor-body">
        <div className="timeline">
          {doc.acts.map((act, a) => (
            <ActLane
              key={act.id}
              act={act}
              index={a}
              total={doc.acts.length}
              pxPerSec={pxPerSec}
              selectedCueId={sel?.actId === act.id ? sel.cueId : undefined}
              multi={multi}
              liveCueId={liveCueId}
              caps={caps}
              onSelect={(cueId, additive) => selectCue(act.id, cueId, additive)}
              onChange={(patch) => change(ops.updateAct(doc, a, patch), `act:${act.id}:${Object.keys(patch).join()}`)}
              onMove={(to) => change(ops.moveAct(doc, a, to))}
              onDelete={() => {
                if (act.cues.length === 0 || confirm(`"${act.title}" 순서와 큐 ${act.cues.length}개를 삭제할까요?`)) {
                  change(ops.deleteAct(doc, a));
                }
              }}
              onAddCue={() => {
                const next = ops.addCue(doc, a, defaultIdGen);
                change(next);
                setSel({ actId: act.id, cueId: next.acts[a].cues.at(-1)!.id });
              }}
              onReorder={(from, to) => change(ops.moveCue(doc, a, from, to))}
            />
          ))}
          <button className="add-act" onClick={() => change(ops.addAct(doc, defaultIdGen))}>
            + 순서(Act) 추가
          </button>
        </div>

        <aside className="inspector">
          {bulk ? (
            <BulkInspector
              service={doc}
              ids={multi}
              caps={caps}
              onChange={(patch) => change(ops.updateCues(doc, multi, patch))}
              onDelete={() => {
                change(ops.deleteCues(doc, multi));
                setMessage({ kind: 'ok', text: `큐 ${multi.size}개를 삭제했습니다 — Ctrl+Z 로 되돌리기` });
                setMulti(new Set());
                setSel(null);
              }}
              onClear={() => setMulti(new Set())}
            />
          ) : pos ? (
            <CueInspector
              key={sel!.cueId}
              service={doc}
              actIndex={pos.a}
              cueIndex={pos.c}
              caps={caps}
              onChange={(patch) => change(ops.updateCue(doc, pos.a, pos.c, patch), `cue:${sel!.cueId}:${Object.keys(patch).join()}`)}
              onMoveToAct={(to) => {
                change(ops.moveCueToAct(doc, pos.a, pos.c, to));
                setSel({ actId: doc.acts[to].id, cueId: sel!.cueId });
              }}
              onDuplicate={() => {
                const next = ops.duplicateCue(doc, pos.a, pos.c, defaultIdGen);
                change(next);
                setSel({ actId: sel!.actId, cueId: next.acts[pos.a].cues[pos.c + 1].id });
              }}
              onDelete={() => {
                change(ops.deleteCue(doc, pos.a, pos.c));
                setSel(null);
              }}
            />
          ) : (
            <div className="muted inspector-help">
              <p>큐 블록을 클릭하면 여기에서 편집합니다.</p>
              <ul>
                <li>블록을 좌우로 드래그해 순서 변경</li>
                <li>블록 너비 = 큐 길이 (점선 = 길이 미정)</li>
                <li>
                  <kbd>Ctrl</kbd>+<kbd>S</kbd> 저장 · <kbd>Delete</kbd> 삭제
                </li>
                <li>
                  <kbd>Alt</kbd>+<kbd>←/→</kbd> 이동 · <kbd>Ctrl</kbd>+<kbd>D</kbd> 복제
                </li>
              </ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function ActLane(props: {
  act: Act;
  index: number;
  total: number;
  pxPerSec: number;
  selectedCueId?: string;
  multi: Set<string>;
  liveCueId?: string;
  caps?: SwitcherCaps;
  onSelect: (cueId: string, additive: boolean) => void;
  onChange: (patch: Partial<Omit<Act, 'id' | 'cues'>>) => void;
  onMove: (to: number) => void;
  onDelete: () => void;
  onAddCue: () => void;
  onReorder: (from: number, to: number) => void;
}) {
  const { act, index, pxPerSec } = props;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), // 클릭과 드래그 구분
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = act.cues.findIndex((c) => c.id === e.active.id);
    const to = act.cues.findIndex((c) => c.id === e.over!.id);
    if (from >= 0 && to >= 0) props.onReorder(from, to);
  };

  const durations = act.cues.map((_, i) => cueDurationMs(act, i));
  const totalMs = durations.every((d) => d != null) ? durations.reduce<number>((s, d) => s + d!, 0) : null;
  const tcs = act.mode === 'TIMECODE' ? cueTimecodes(act) : null;

  return (
    <section className="lane">
      <header className="lane-header">
        <span className="lane-index">{index + 1}</span>
        <input className="lane-title" value={act.title} onChange={(e) => props.onChange({ title: e.target.value })} />
        <select value={act.mode} onChange={(e) => props.onChange({ mode: e.target.value as Act['mode'] })} title="진행 모드">
          {ADVANCE_MODES.map((m) => (
            <option key={m} value={m}>
              {MODE_LABEL[m]} ({m})
            </option>
          ))}
        </select>
        {act.mode === 'SECTION' && (
          <>
            <label className="row">
              BPM
              <NumberInput value={act.bpm} onChange={(bpm) => props.onChange({ bpm })} min={20} max={400} step={1} width={64} />
            </label>
            <label className="row">
              박자
              <NumberInput
                value={act.beatsPerBar}
                onChange={(v) => props.onChange({ beatsPerBar: v ?? 4 })}
                min={1}
                max={16}
                step={1}
                width={48}
              />
              /4
            </label>
          </>
        )}
        <span className="muted">
          큐 {act.cues.length}개{totalMs != null && act.cues.length > 0 ? ` · ${formatClock(totalMs)}` : ''}
        </span>
        <span className="spacer" />
        <button onClick={() => props.onMove(index - 1)} disabled={index === 0} title="위로">
          ↑
        </button>
        <button onClick={() => props.onMove(index + 1)} disabled={index === props.total - 1} title="아래로">
          ↓
        </button>
        <button className="danger" onClick={props.onDelete} title="순서 삭제">
          ✕
        </button>
      </header>

      <div className="lane-track">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={act.cues.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
            {act.cues.map((cue, i) => (
              <CueBlock
                key={cue.id}
                cue={cue}
                index={i}
                durationMs={durations[i]}
                tcIn={tcs?.[i] ?? null}
                showSection={act.mode === 'SECTION' && cue.section != null && cue.section !== act.cues[i - 1]?.section}
                width={durations[i] != null ? Math.max(MIN_WIDTH, (durations[i]! / 1000) * pxPerSec) : UNKNOWN_WIDTH}
                selected={props.selectedCueId === cue.id || props.multi.has(cue.id)}
                live={props.liveCueId === cue.id}
                problem={cueProblem(cue, props.caps)}
                onSelect={(additive) => props.onSelect(cue.id, additive)}
              />
            ))}
          </SortableContext>
        </DndContext>
        <button className="add-cue" onClick={props.onAddCue} title="큐 추가">
          +
        </button>
      </div>
    </section>
  );
}

function CueBlock(props: {
  cue: Cue;
  index: number;
  durationMs: number | null;
  tcIn: number | null;
  showSection: boolean;
  width: number;
  selected: boolean;
  live: boolean;
  problem: string | null;
  onSelect: (additive: boolean) => void;
}) {
  const { cue } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: cue.id });
  const style = {
    width: props.width,
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    borderTopColor: cameraColor(cue.camera),
  };
  const cls = ['cue-block', props.selected && 'selected', props.live && 'live', props.durationMs == null && 'unknown', isDragging && 'dragging']
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={setNodeRef} style={style} className={cls} onClick={(e) => props.onSelect(e.ctrlKey || e.metaKey || e.shiftKey)} {...attributes} {...listeners}>
      {cue.section && (
        <div className="cue-section" style={{ background: sectionColor(cue.section), opacity: props.showSection ? 1 : 0.45 }}>
          {cue.section}
        </div>
      )}
      <div className="cue-top">
        <span className="cam-chip" style={{ background: cameraColor(cue.camera) }}>
          {cue.camera}
        </span>
        <b>{cue.shotSize}</b>
        <span className="muted mono">#{props.index + 1}</span>
        {props.problem && (
          <span className="cue-problem" title={props.problem}>
            ⚠
          </span>
        )}
      </div>
      <div className="cue-note">
        {parseNote(cue.note).important && <span style={{ color: '#facc15' }}>⚠ </span>}
        {parseNote(cue.note).text || <span className="muted">(메모 없음)</span>}
      </div>
      <div className="cue-foot mono muted">
        {props.tcIn != null && <span>@{formatClock(props.tcIn * 1000)} </span>}
        {cue.bars != null && <span>{cue.bars}마디 </span>}
        {props.durationMs != null && <span>{(props.durationMs / 1000).toFixed(1)}s </span>}
        {cue.atemAction !== 'cut' && <span className="atem-tag">{cue.atemAction}</span>}
      </div>
    </div>
  );
}

function CueInspector(props: {
  service: Service;
  actIndex: number;
  cueIndex: number;
  caps?: SwitcherCaps;
  onChange: (patch: Partial<Omit<Cue, 'id'>>) => void;
  onMoveToAct: (to: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const act = props.service.acts[props.actIndex];
  const cue = act.cues[props.cueIndex];
  const set = props.onChange;
  const dur = cueDurationMs(act, props.cueIndex);
  const problem = cueProblem(cue, props.caps);
  const camOk = (n: number) => !props.caps?.cameras || props.caps.cameras.includes(n);

  return (
    <div className="inspector-form">
      <h3>
        큐 #{props.cueIndex + 1} <span className="muted">· {act.title}</span>
      </h3>
      {problem && <div className="inspector-warn">⚠ {problem}</div>}

      <Field label="카메라">
        <div className="seg">
          {CAMERAS.map((n) => (
            <button
              key={n}
              className={`${cue.camera === n ? 'on' : ''} ${camOk(n) ? '' : 'no-output'}`}
              style={cue.camera === n ? { background: cameraColor(n), borderColor: cameraColor(n), color: '#000' } : { color: cameraColor(n) }}
              title={camOk(n) ? undefined : '현재 스위처 설정에 이 카메라의 컷 출력이 없습니다'}
              onClick={() => set({ camera: n })}
            >
              {n}
            </button>
          ))}
        </div>
      </Field>

      <Field label="샷 사이즈">
        <div className="seg wrap">
          {SHOT_SIZES.map((s) => (
            <button key={s} className={cue.shotSize === s ? 'on' : ''} onClick={() => set({ shotSize: s })} title={SHOT_LABEL[s]}>
              {s}
            </button>
          ))}
        </div>
      </Field>

      <Field label="메모 (카메라맨에게 보임)">
        <textarea
          rows={2}
          value={parseNote(cue.note).text}
          maxLength={500}
          onChange={(e) => set({ note: setImportant(e.target.value, parseNote(cue.note).important) })}
        />
        {[...parseNote(cue.note).text].length > 55 && (
          <div className="muted" style={{ fontSize: 12, color: 'var(--hold)' }}>
            메모가 길어 폰에서는 글자가 작게 보입니다 ({[...parseNote(cue.note).text].length}자) — 핵심만 짧게 쓰면 잘 보입니다
          </div>
        )}
        <label className="row" style={{ marginTop: 6, fontSize: 13, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={parseNote(cue.note).important}
            onChange={(e) => set({ note: setImportant(cue.note, e.target.checked) })}
          />
          <span>
            ⚠ <b>중요 메모</b> <span className="muted">— 카메라맨 화면에 노란색으로 강조</span>
          </span>
        </label>
      </Field>

      <Field label="섹션">
        <div className="seg wrap">
          <button className={cue.section == null ? 'on' : ''} onClick={() => set({ section: null })}>
            없음
          </button>
          {SECTION_PRESETS.map((s) => (
            <button
              key={s}
              className={cue.section === s ? 'on' : ''}
              style={cue.section === s ? { background: sectionColor(s), borderColor: sectionColor(s) } : undefined}
              onClick={() => set({ section: s })}
            >
              {s}
            </button>
          ))}
        </div>
        <input
          placeholder="직접 입력 (예: CH2)"
          value={cue.section ?? ''}
          onChange={(e) => set({ section: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 12) || null })}
          style={{ marginTop: 6, width: 160 }}
        />
      </Field>

      <div className="grid2">
        <Field label={`마디 수${act.mode === 'SECTION' ? '' : ' (SECTION 모드용)'}`}>
          <NumberInput value={cue.bars} onChange={(bars) => set({ bars })} min={0.25} step={1} />
        </Field>
        <Field label="길이 (초)">
          <NumberInput value={cue.durationSec} onChange={(durationSec) => set({ durationSec })} min={0.1} step={1} />
        </Field>
        <Field label={`TC 진입 (초)${act.mode === 'TIMECODE' ? '' : ' (TIMECODE용)'}`}>
          <NumberInput value={cue.tcInSec} onChange={(tcInSec) => set({ tcInSec })} min={0} step={1} placeholder="자동(누적)" />
        </Field>
        <Field label="계산된 길이">
          <div className="mono" style={{ paddingTop: 6 }}>
            {dur != null ? `${(dur / 1000).toFixed(2)}s` : '미정 (수동 GO)'}
          </div>
        </Field>
      </div>

      <Field label="스위처 동작">
        <AtemActionInput value={cue.atemAction} caps={props.caps} onChange={(atemAction) => set({ atemAction })} />
      </Field>

      <Field label="다른 순서로 이동">
        <select value={props.actIndex} onChange={(e) => props.onMoveToAct(Number(e.target.value))}>
          {props.service.acts.map((a, i) => (
            <option key={a.id} value={i}>
              {i + 1}. {a.title}
            </option>
          ))}
        </select>
      </Field>

      <div className="row" style={{ marginTop: 16 }}>
        <button onClick={props.onDuplicate}>복제</button>
        <span className="spacer" />
        <button className="danger" onClick={props.onDelete}>
          큐 삭제
        </button>
      </div>
    </div>
  );
}

function AtemActionInput({ value, caps, onChange }: { value: string; caps?: SwitcherCaps; onChange: (v: string) => void }) {
  const no = (ok: boolean | undefined, text: string) => (ok === false ? ` — ${text}` : '');
  const parsed: AtemAction = parseAtemAction(value) ?? { kind: 'cut' };
  const emit = (a: AtemAction) => onChange(formatAtemAction(a));
  return (
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <select
        value={parsed.kind}
        onChange={(e) => {
          const k = e.target.value as AtemAction['kind'];
          emit(k === 'macro' ? { kind: 'macro', index: 1 } : k === 'dsk' ? { kind: 'dsk', keyer: 1, onAir: true } : { kind: k });
        }}
      >
        <option value="cut">CUT (즉시 전환)</option>
        <option value="auto">AUTO (트랜지션){no(caps?.transition, '이 스위처는 컷으로 나감')}</option>
        <option value="macro">매크로 실행{no(caps?.macro, '이 스위처 미지원')}</option>
        <option value="dsk">DSK 키어 ON/OFF{no(caps?.dsk, '이 스위처 미지원')}</option>
      </select>
      {parsed.kind === 'macro' && (
        <label className="row">
          #
          <NumberInput value={parsed.index} onChange={(v) => emit({ kind: 'macro', index: Math.max(1, Math.round(v ?? 1)) })} min={1} step={1} width={64} />
        </label>
      )}
      {parsed.kind === 'dsk' && (
        <>
          <select value={parsed.keyer} onChange={(e) => emit({ ...parsed, keyer: Number(e.target.value) })}>
            {[1, 2, 3, 4].map((k) => (
              <option key={k} value={k}>
                DSK {k}
              </option>
            ))}
          </select>
          <select value={parsed.onAir ? 'on' : 'off'} onChange={(e) => emit({ ...parsed, onAir: e.target.value === 'on' })}>
            <option value="on">ON</option>
            <option value="off">OFF</option>
          </select>
        </>
      )}
      <code className="muted">{value}</code>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      {children}
    </div>
  );
}

/** 빈 값 = null 인 숫자 입력 */
function NumberInput(props: {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  width?: number;
  placeholder?: string;
}) {
  const [text, setText] = useState(props.value?.toString() ?? '');
  useEffect(() => {
    // 외부에서 값이 바뀐 경우에만 입력 텍스트 동기화 (입력 중인 "1." 같은 중간 상태 보존)
    const current = text === '' ? null : Number(text);
    if (current !== props.value) setText(props.value?.toString() ?? '');
  }, [props.value]);
  return (
    <input
      type="number"
      inputMode="decimal"
      value={text}
      min={props.min}
      max={props.max}
      step={props.step}
      placeholder={props.placeholder ?? '-'}
      style={{ width: props.width ?? 100 }}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value === '') return props.onChange(null);
        const n = Number(e.target.value);
        if (Number.isFinite(n) && (props.min == null || n >= props.min) && (props.max == null || n <= props.max)) props.onChange(n);
      }}
    />
  );
}

/** 다른 행사의 순서(Act)를 큐째로 복사해 오기 (새 id 발급) */
function ActImporter({ currentId, onClose, onImport }: { currentId: string; onClose: () => void; onImport: (acts: Act[]) => void }) {
  const [list, setList] = useState<ServiceSummary[] | null>(null);
  const [src, setSrc] = useState<Service | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .listServices()
      .then((l) => setList(l.filter((s) => s.id !== currentId)))
      .catch((e) => setError(e.message));
  }, [currentId]);
  const choose = (id: string) => {
    setPicked(new Set());
    api.getService(id).then(setSrc).catch((e) => setError(e.message));
  };
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const doImport = () => {
    if (!src) return;
    const acts = src.acts
      .filter((a) => picked.has(a.id))
      .map((a) => ({ ...a, id: defaultIdGen(), cues: a.cues.map((c) => ({ ...c, id: defaultIdGen() })) }));
    onImport(acts);
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>다른 행사에서 순서 가져오기</h3>
        {error && <p className="editor-msg err">{error}</p>}
        <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
          <div style={{ flex: 1, maxHeight: 360, overflow: 'auto' }}>
            <div className="muted" style={{ fontSize: 12 }}>
              ① 행사
            </div>
            {list === null && <p className="muted">불러오는 중…</p>}
            {list?.map((s) => (
              <div key={s.id}>
                <button className={src?.id === s.id ? 'primary' : ''} style={{ width: '100%', textAlign: 'left', marginTop: 4 }} onClick={() => choose(s.id)}>
                  {s.date ?? ''} {s.title} <span className="muted">({s.actCount})</span>
                </button>
              </div>
            ))}
          </div>
          <div style={{ flex: 1, maxHeight: 360, overflow: 'auto' }}>
            <div className="muted" style={{ fontSize: 12 }}>
              ② 가져올 순서
            </div>
            {src?.acts.map((a) => (
              <label key={a.id} className="row" style={{ marginTop: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={picked.has(a.id)} onChange={() => toggle(a.id)} />
                <span>
                  {a.title} <span className="muted">· {MODE_LABEL[a.mode]} · 큐 {a.cues.length}</span>
                </span>
              </label>
            ))}
            {src && src.acts.length === 0 && <p className="muted">순서가 없습니다</p>}
          </div>
        </div>
        <div className="row" style={{ marginTop: 16 }}>
          <span className="spacer" />
          <button onClick={onClose}>취소</button>
          <button className="primary" disabled={picked.size === 0} onClick={doImport}>
            {picked.size}개 끝에 붙이기
          </button>
        </div>
      </div>
    </div>
  );
}

/** 여러 큐 한꺼번에 고치기 */
function BulkInspector({
  service,
  ids,
  caps,
  onChange,
  onDelete,
  onClear,
}: {
  service: Service;
  ids: Set<string>;
  caps?: SwitcherCaps;
  onChange: (patch: Partial<Omit<Cue, 'id'>>) => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const cues = service.acts.flatMap((a) => a.cues.filter((c) => ids.has(c.id)));
  const same = <K extends keyof Cue>(k: K) => (cues.every((c) => c[k] === cues[0]?.[k]) ? cues[0]?.[k] : undefined);
  const camOk = (n: number) => !caps?.cameras || caps.cameras.includes(n);
  return (
    <div className="inspector-form">
      <h3>
        큐 {cues.length}개 일괄 편집 <span className="muted">· Ctrl/Shift+클릭으로 더하거나 빼기</span>
      </h3>
      <Field label="카메라 (모두 바꾸기)">
        <div className="seg">
          {CAMERAS.map((n) => (
            <button
              key={n}
              className={`${same('camera') === n ? 'on' : ''} ${camOk(n) ? '' : 'no-output'}`}
              style={same('camera') === n ? { background: cameraColor(n), borderColor: cameraColor(n), color: '#000' } : { color: cameraColor(n) }}
              onClick={() => onChange({ camera: n })}
            >
              {n}
            </button>
          ))}
        </div>
      </Field>
      <Field label="샷 사이즈 (모두 바꾸기)">
        <div className="seg wrap">
          {SHOT_SIZES.map((sz) => (
            <button key={sz} className={same('shotSize') === sz ? 'on' : ''} onClick={() => onChange({ shotSize: sz })} title={SHOT_LABEL[sz]}>
              {sz}
            </button>
          ))}
        </div>
      </Field>
      <Field label="스위처 동작 (모두 바꾸기)">
        <div className="seg">
          <button className={same('atemAction') === 'cut' ? 'on' : ''} onClick={() => onChange({ atemAction: 'cut' })}>
            CUT
          </button>
          <button className={same('atemAction') === 'auto' ? 'on' : ''} onClick={() => onChange({ atemAction: 'auto' })}>
            AUTO{caps && !caps.transition ? ' (이 스위처는 컷)' : ''}
          </button>
        </div>
      </Field>
      <div className="row" style={{ marginTop: 16 }}>
        <button onClick={onClear}>선택 해제 (Esc)</button>
        <span className="spacer" />
        <button className="danger" onClick={() => confirm(`큐 ${cues.length}개를 삭제할까요? (Ctrl+Z 로 되돌릴 수 있음)`) && onDelete()}>
          {cues.length}개 삭제
        </button>
      </div>
    </div>
  );
}

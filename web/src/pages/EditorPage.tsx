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
import { formatAtemAction, parseAtemAction, type AtemAction } from '@shared/atemAction';
import { cueDurationMs, cueTimecodes } from '@shared/engine';
import { defaultIdGen, ops } from '@shared/editorOps';
import { formatZodError, serviceInputSchema } from '@shared/schema';
import { ADVANCE_MODES, MAX_CAMERA, SECTION_PRESETS, SHOT_SIZES, type Act, type Cue, type Service, type ServiceSummary } from '@shared/types';
import { TopBar } from '../components/TopBar';
import { api } from '../lib/api';
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
  const [pxPerSec, setPxPerSec] = useState(8);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

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
      const s = await api.saveService(serviceId, doc);
      setDoc(s);
      setSaved(s);
      setMessage({ kind: 'ok', text: isLive ? '저장됨 — 라이브에 즉시 반영' : '저장됨' });
    } catch (e) {
      setMessage({ kind: 'err', text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }, [doc, serviceId, isLive]);

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
      if (!doc || !pos || isTyping(e.target)) return;
      if (e.key === 'Delete') {
        setDoc(ops.deleteCue(doc, pos.a, pos.c));
        setSel(null);
      } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        setDoc(ops.moveCue(doc, pos.a, pos.c, pos.c + (e.key === 'ArrowLeft' ? -1 : 1)));
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const next = ops.duplicateCue(doc, pos.a, pos.c, defaultIdGen);
        setDoc(next);
        setSel({ actId: sel!.actId, cueId: next.acts[pos.a].cues[pos.c + 1].id });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doc, pos, sel, save]);

  const importJson = async (file: File) => {
    try {
      const s = await api.importService(JSON.parse(await file.text()));
      navigate(`/editor/${s.id}`);
      setMessage({ kind: 'ok', text: `"${s.title}" 을(를) 새 행사로 가져왔습니다` });
    } catch (e) {
      setMessage({ kind: 'err', text: `가져오기 실패: ${(e as Error).message}` });
    }
  };

  const remove = async () => {
    if (!doc || !confirm(`"${doc.title}" 행사를 삭제할까요? 되돌릴 수 없습니다.`)) return;
    await api.deleteService(serviceId);
    navigate('/');
  };

  const goLive = async () => {
    if (dirty && !confirm('저장하지 않은 변경이 있습니다. 저장된 버전으로 라이브를 열까요?')) return;
    await api.loadShow(serviceId);
    navigate('/director');
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

  const liveCueId = isLive && live.service ? live.service.acts[live.snapshot!.state.actIndex]?.cues[live.snapshot!.state.cueIndex]?.id : undefined;

  return (
    <div className="editor">
      <TopBar>
        {isLive && <span className="badge" style={{ borderColor: 'var(--pgm)', color: '#fca5a5' }}>● 라이브 중인 행사</span>}
        {dirty && <span className="badge" style={{ borderColor: 'var(--hold)' }}>저장 안 됨</span>}
      </TopBar>

      <div className="editor-toolbar">
        <input className="title-input" value={doc.title} onChange={(e) => setDoc(ops.updateService(doc, { title: e.target.value }))} />
        <input type="date" value={doc.date ?? ''} onChange={(e) => setDoc(ops.updateService(doc, { date: e.target.value || null }))} />
        <button className="primary" onClick={save} disabled={!dirty || saving} title="Ctrl+S">
          {saving ? '저장 중…' : '저장'}
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
              liveCueId={liveCueId}
              onSelect={(cueId) => setSel({ actId: act.id, cueId })}
              onChange={(patch) => setDoc(ops.updateAct(doc, a, patch))}
              onMove={(to) => setDoc(ops.moveAct(doc, a, to))}
              onDelete={() => {
                if (act.cues.length === 0 || confirm(`"${act.title}" 순서와 큐 ${act.cues.length}개를 삭제할까요?`)) {
                  setDoc(ops.deleteAct(doc, a));
                }
              }}
              onAddCue={() => {
                const next = ops.addCue(doc, a, defaultIdGen);
                setDoc(next);
                setSel({ actId: act.id, cueId: next.acts[a].cues.at(-1)!.id });
              }}
              onReorder={(from, to) => setDoc(ops.moveCue(doc, a, from, to))}
            />
          ))}
          <button className="add-act" onClick={() => setDoc(ops.addAct(doc, defaultIdGen))}>
            + 순서(Act) 추가
          </button>
        </div>

        <aside className="inspector">
          {pos ? (
            <CueInspector
              key={sel!.cueId}
              service={doc}
              actIndex={pos.a}
              cueIndex={pos.c}
              onChange={(patch) => setDoc(ops.updateCue(doc, pos.a, pos.c, patch))}
              onMoveToAct={(to) => {
                setDoc(ops.moveCueToAct(doc, pos.a, pos.c, to));
                setSel({ actId: doc.acts[to].id, cueId: sel!.cueId });
              }}
              onDuplicate={() => {
                const next = ops.duplicateCue(doc, pos.a, pos.c, defaultIdGen);
                setDoc(next);
                setSel({ actId: sel!.actId, cueId: next.acts[pos.a].cues[pos.c + 1].id });
              }}
              onDelete={() => {
                setDoc(ops.deleteCue(doc, pos.a, pos.c));
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
  liveCueId?: string;
  onSelect: (cueId: string) => void;
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
                selected={props.selectedCueId === cue.id}
                live={props.liveCueId === cue.id}
                onSelect={() => props.onSelect(cue.id)}
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
  onSelect: () => void;
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
    <div ref={setNodeRef} style={style} className={cls} onClick={props.onSelect} {...attributes} {...listeners}>
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
      </div>
      <div className="cue-note">{cue.note || <span className="muted">(메모 없음)</span>}</div>
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
  onChange: (patch: Partial<Omit<Cue, 'id'>>) => void;
  onMoveToAct: (to: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const act = props.service.acts[props.actIndex];
  const cue = act.cues[props.cueIndex];
  const set = props.onChange;
  const dur = cueDurationMs(act, props.cueIndex);

  return (
    <div className="inspector-form">
      <h3>
        큐 #{props.cueIndex + 1} <span className="muted">· {act.title}</span>
      </h3>

      <Field label="카메라">
        <div className="seg">
          {CAMERAS.map((n) => (
            <button
              key={n}
              className={cue.camera === n ? 'on' : ''}
              style={cue.camera === n ? { background: cameraColor(n), borderColor: cameraColor(n), color: '#000' } : { color: cameraColor(n) }}
              onClick={() => set({ camera: n })}
            >
              {n}
            </button>
          ))}
        </div>
      </Field>

      <Field label="샷 사이즈">
        <div className="seg">
          {SHOT_SIZES.map((s) => (
            <button key={s} className={cue.shotSize === s ? 'on' : ''} onClick={() => set({ shotSize: s })} title={SHOT_LABEL[s]}>
              {s}
            </button>
          ))}
        </div>
      </Field>

      <Field label="메모 (카메라맨에게 보임)">
        <textarea rows={2} value={cue.note} maxLength={500} onChange={(e) => set({ note: e.target.value })} />
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
          onChange={(e) => set({ section: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || null })}
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

      <Field label="ATEM 액션">
        <AtemActionInput value={cue.atemAction} onChange={(atemAction) => set({ atemAction })} />
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

function AtemActionInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
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
        <option value="auto">AUTO (트랜지션)</option>
        <option value="macro">매크로 실행</option>
        <option value="dsk">DSK 키어 ON/OFF</option>
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

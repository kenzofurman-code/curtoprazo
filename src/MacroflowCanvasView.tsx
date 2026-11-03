// Componente Visual do Criador de Macrofluxo (Process Mapping com Matriz de Colunas/Etapas)
// Suporta alinhamento de raias por etapas temporais compartilhadas, vínculos inter-raias e tema claro coerente
import React, { useState, useRef, useMemo, useEffect } from 'react';
import type {
  MacroflowProjectData,
  MacroflowSwimlane,
  MacroflowPackage,
  InterSwimlaneLink,
} from './macroflowModel';
import {
  getDefaultMacroflowModel,
  exportMacroflowToExcel,
  parseMacroflowFromExcel,
  applyMacroflowToSchedule,
} from './macroflowModel';
import type { LongTermScheduleState } from './longTermSchedule';

interface MacroflowCanvasViewProps {
  isOpen: boolean;
  onClose: () => void;
  currentState: LongTermScheduleState;
  onApplyToSchedule: (nextState: LongTermScheduleState, message?: string) => void;
  projectName?: string;
  selectedProjectId?: string;
}

export const MacroflowCanvasView: React.FC<MacroflowCanvasViewProps> = ({
  isOpen,
  onClose,
  currentState,
  onApplyToSchedule,
  projectName = 'Obra',
  selectedProjectId,
}) => {
  // Carrega dados persistidos ou um macrofluxo vazio
  const [data, setData] = useState<MacroflowProjectData>(() => {
    const storageKey = `curtoprazo_macroflow_${selectedProjectId || 'global'}`;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && Array.isArray(parsed.swimlanes)) {
          return parsed;
        }
      }
    } catch (_) {}
    return getDefaultMacroflowModel();
  });

  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const [isInterLinkModalOpen, setIsInterLinkModalOpen] = useState<boolean>(false);
  const [expandedJobs, setExpandedJobs] = useState<Record<string, boolean>>({});

  // Form de criação de vínculo inter-raia
  const [linkSourceSwId, setLinkSourceSwId] = useState<string>('');
  const [linkSourcePkgId, setLinkSourcePkgId] = useState<string>('');
  const [linkTargetSwId, setLinkTargetSwId] = useState<string>('');
  const [linkTargetPkgId, setLinkTargetPkgId] = useState<string>('');
  const [linkType, setLinkType] = useState<'finish_to_start' | 'floor_lag' | 'day_lag'>('finish_to_start');
  const [linkLagValue, setLinkLagValue] = useState<number>(5);
  const [linkDescription, setLinkDescription] = useState<string>('');

  // Edição rápida de card / adicionar sub-tarefa
  const [newJobInputs, setNewJobInputs] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasScrollRef = useRef<HTMLDivElement>(null);

  // Auto-persistência no localStorage
  useEffect(() => {
    if (!data) return;
    try {
      const storageKey = `curtoprazo_macroflow_${selectedProjectId || 'global'}`;
      localStorage.setItem(storageKey, JSON.stringify(data));
    } catch (_) {}
  }, [data, selectedProjectId]);

  // Quantidade de colunas globais / etapas temporais
  const maxCol = useMemo(() => {
    let max = 35;
    (data?.swimlanes || []).forEach((sw) => {
      sw.packages.forEach((pkg) => {
        const c = pkg.colIndex ?? pkg.position ?? 0;
        if (c > max) max = c;
      });
    });
    return Math.max(35, max);
  }, [data]);

  const allCols = useMemo(() => {
    return Array.from({ length: maxCol }, (_, i) => i + 1);
  }, [maxCol]);

  // Toggle expansão das tarefas de um pacote
  const toggleJobs = (pkgId: string) => {
    setExpandedJobs((prev) => ({ ...prev, [pkgId]: !prev[pkgId] }));
  };

  // Desloca o pacote horizontalmente para a esquerda ou direita entre etapas
  const handleShiftPackageCol = (swId: string, pkgId: string, delta: number) => {
    setData((prev) => ({
      ...prev,
      swimlanes: prev.swimlanes.map((s) => {
        if (s.id !== swId) return s;
        return {
          ...s,
          packages: s.packages.map((p) => {
            if (p.id !== pkgId) return p;
            const curCol = p.colIndex ?? p.position ?? 1;
            const newCol = Math.max(1, curCol + delta);
            return { ...p, colIndex: newCol };
          }),
        };
      }),
    }));
  };

  // Adiciona sub-tarefa a um pacote
  const handleAddJob = (swId: string, pkgId: string) => {
    const text = (newJobInputs[pkgId] || '').trim();
    if (!text) return;
    setData((prev) => {
      const nextSw = prev.swimlanes.map((sw) => {
        if (sw.id !== swId) return sw;
        return {
          ...sw,
          packages: sw.packages.map((pkg) => {
            if (pkg.id !== pkgId) return pkg;
            return {
              ...pkg,
              jobs: [
                ...(pkg.jobs || []),
                {
                  id: `j_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 5)}`,
                  name: text.toUpperCase(),
                  defaultDurationDays: 2,
                },
              ],
            };
          }),
        };
      });
      return { ...prev, swimlanes: nextSw, updatedAt: new Date().toISOString() };
    });
    setNewJobInputs((prev) => ({ ...prev, [pkgId]: '' }));
    setExpandedJobs((prev) => ({ ...prev, [pkgId]: true }));
  };

  // Remove sub-tarefa
  const handleRemoveJob = (swId: string, pkgId: string, jobId: string) => {
    setData((prev) => ({
      ...prev,
      swimlanes: prev.swimlanes.map((sw) => {
        if (sw.id !== swId) return sw;
        return {
          ...sw,
          packages: sw.packages.map((pkg) => {
            if (pkg.id !== pkgId) return pkg;
            return {
              ...pkg,
              jobs: (pkg.jobs || []).filter((j) => j.id !== jobId),
            };
          }),
        };
      }),
    }));
  };

  // Adiciona novo pacote a uma raia em coluna específica
  const handleAddPackage = (swId: string, targetColIndex?: number) => {
    const sw = data.swimlanes.find((s) => s.id === swId);
    if (!sw) return;

    const col = targetColIndex || sw.packages.length + 1;
    const newPkg: MacroflowPackage = {
      id: `pkg_${Date.now().toString(36)}`,
      name: 'NOVO PACOTE',
      color: sw.color || '#0284c7',
      rhythmText: '10d - por pvto',
      rhythmDays: 10,
      position: sw.packages.length + 1,
      colIndex: col,
      jobs: [],
    };

    setData((prev) => ({
      ...prev,
      swimlanes: prev.swimlanes.map((s) => {
        if (s.id !== swId) return s;
        return {
          ...s,
          packages: [...s.packages, newPkg],
        };
      }),
    }));
  };

  // Remove pacote
  const handleRemovePackage = (swId: string, pkgId: string) => {
    if (!confirm('Deseja realmente remover este pacote de trabalho do macrofluxo?')) return;
    setData((prev) => ({
      ...prev,
      swimlanes: prev.swimlanes.map((s) => {
        if (s.id !== swId) return s;
        return {
          ...s,
          packages: s.packages.filter((p) => p.id !== pkgId),
        };
      }),
      interLinks: prev.interLinks.filter(
        (l) => l.sourcePackageId !== pkgId && l.targetPackageId !== pkgId
      ),
    }));
  };

  // Atualiza nome ou ritmo do pacote
  const handleUpdatePackage = (swId: string, pkgId: string, updates: Partial<MacroflowPackage>) => {
    setData((prev) => ({
      ...prev,
      swimlanes: prev.swimlanes.map((s) => {
        if (s.id !== swId) return s;
        return {
          ...s,
          packages: s.packages.map((p) => (p.id === pkgId ? { ...p, ...updates } : p)),
        };
      }),
    }));
  };

  // Criar vínculo inter-raia
  const handleAddInterLink = () => {
    if (!linkSourceSwId || !linkSourcePkgId || !linkTargetSwId || !linkTargetPkgId) {
      alert('Selecione os pacotes de origem e destino para o vínculo.');
      return;
    }
    if (linkSourcePkgId === linkTargetPkgId) {
      alert('O pacote de origem não pode ser o mesmo do destino.');
      return;
    }

    const newLink: InterSwimlaneLink = {
      id: `lnk_${Date.now().toString(36)}`,
      sourceSwimlaneId: linkSourceSwId,
      sourcePackageId: linkSourcePkgId,
      targetSwimlaneId: linkTargetSwId,
      targetPackageId: linkTargetPkgId,
      type: linkType,
      lagValue: linkLagValue,
      description: linkDescription.trim(),
    };

    setData((prev) => ({
      ...prev,
      interLinks: [...prev.interLinks, newLink],
    }));

    setIsInterLinkModalOpen(false);
    setLinkDescription('');
  };

  // Remove vínculo inter-raia
  const handleRemoveInterLink = (linkId: string) => {
    setData((prev) => ({
      ...prev,
      interLinks: prev.interLinks.filter((l) => l.id !== linkId),
    }));
  };

  // Importar Excel do usuário
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const buffer = evt.target?.result as ArrayBuffer;
        const parsed = parseMacroflowFromExcel(buffer);
        setData(parsed);
        alert(`Macrofluxo importado com sucesso! ${parsed.swimlanes.length} raias carregadas.`);
      } catch (err) {
        console.error('Erro ao importar macrofluxo:', err);
        alert('Erro ao processar arquivo Excel. Certifique-se de que é uma planilha válida.');
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  };

  // Salva o macrofluxo e sincroniza com o cronograma da aplicação
  const handleSaveMacroflow = () => {
    if (!data.swimlanes.length || !currentState.floors.length) {
      alert('Cadastre os locais da obra e importe o macrofluxo antes de aplicar ao cronograma.');
      return;
    }
    const nextSchedule = applyMacroflowToSchedule(data, currentState, {
      defaultStartDate: currentState.calendar.startDate,
    });
    onApplyToSchedule(nextSchedule, 'Macrofluxo salvo com sucesso!');
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex flex-col select-none animate-in fade-in duration-150">
      {/* =====================================================================
          1. BARRA SUPERIOR: TÍTULO LIMPO, FERRAMENTAS E BOTÃO SALVAR MACROFLUXO
         ===================================================================== */}
      <header className="bg-white border-b border-slate-200 text-slate-800 px-5 py-3 flex flex-wrap items-center justify-between gap-3 shrink-0 shadow-xs">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 flex items-center justify-center text-lg font-bold">
            🔀
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-800 tracking-tight">
              Macrofluxo
            </h2>
            <p className="text-[11px] text-slate-500">
              Mapeamento de pacotes por etapa e vínculos entre raias
            </p>
          </div>
        </div>

        {/* FERRAMENTAS & BOTÕES PRINCIPAIS */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Zoom Controls */}
          <div className="flex items-center bg-slate-100 border border-slate-200 rounded-xl px-2 py-1 text-xs">
            <button
              type="button"
              onClick={() => setZoomLevel((z) => Math.max(50, z - 10))}
              className="px-2 py-0.5 hover:bg-slate-200 rounded font-bold text-slate-700"
              title="Reduzir zoom"
            >
              -
            </button>
            <span className="font-mono px-2 text-slate-700 font-bold">{zoomLevel}%</span>
            <button
              type="button"
              onClick={() => setZoomLevel((z) => Math.min(150, z + 10))}
              className="px-2 py-0.5 hover:bg-slate-200 rounded font-bold text-slate-700"
              title="Aumentar zoom"
            >
              +
            </button>
            <button
              type="button"
              onClick={() => setZoomLevel(100)}
              className="ml-1 text-[10px] font-bold text-slate-500 hover:text-slate-800"
            >
              100%
            </button>
          </div>

          {/* Baixar Planilha Modelo */}
          <button
            type="button"
            onClick={() => exportMacroflowToExcel(data, projectName)}
            className="px-3 py-1.5 rounded-xl bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 text-xs font-semibold transition flex items-center gap-1.5 shadow-2xs"
            title="Baixar planilha Excel do macrofluxo"
          >
            <span>📄</span> Baixar Modelo (.xlsx)
          </button>

          {/* Importar Planilha */}
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            accept=".xlsx,.xls,.csv"
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1.5 rounded-xl bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 text-xs font-semibold transition flex items-center gap-1.5 shadow-2xs"
            title="Importar planilha Excel preenchida"
          >
            <span>📤</span> Importar (.xlsx)
          </button>

          {/* Conexões Inter-Raias */}
          <button
            type="button"
            onClick={() => {
              if (data.swimlanes[1] && data.swimlanes[2]) {
                setLinkSourceSwId(data.swimlanes[1].id);
                setLinkSourcePkgId(data.swimlanes[1].packages[0]?.id || '');
                setLinkTargetSwId(data.swimlanes[2].id);
                setLinkTargetPkgId(data.swimlanes[2].packages[0]?.id || '');
              }
              setIsInterLinkModalOpen(true);
            }}
            className="px-3 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-xs font-semibold transition flex items-center gap-1.5 shadow-2xs"
            title="Configurar conexões entre raias diferentes (ex: Torre -> Fachada)"
          >
            <span>🔗</span> Vínculos Inter-Raias ({data.interLinks.length})
          </button>

          {/* BOTÃO PRINCIPAL: SALVAR MACROFLUXO */}
          <button
            type="button"
            onClick={handleSaveMacroflow}
            className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold transition shadow-xs flex items-center gap-2 active:scale-95"
            title="Salvar alterações do macrofluxo"
          >
            <span>💾</span> Salvar Macrofluxo
          </button>

          {/* Fechar */}
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-500 hover:text-slate-800 flex items-center justify-center font-bold text-base transition ml-2"
            title="Fechar tela de macrofluxo (Esc)"
          >
            ✕
          </button>
        </div>
      </header>

      {/* =====================================================================
          2. CANVAS CLARO COM GRADE DE ETAPAS / COLUNAS SINCRONIZADAS
         ===================================================================== */}
      <main
        ref={canvasScrollRef}
        className="flex-1 overflow-auto bg-[#f8fafc] relative select-none"
        style={{
          backgroundImage: 'radial-gradient(#cbd5e1 1.5px, transparent 1.5px)',
          backgroundSize: '24px 24px',
        }}
      >
        <div
          className="p-6 min-w-max space-y-4 transition-transform origin-top-left"
          style={{
            transform: `scale(${zoomLevel / 100})`,
          }}
        >
          {!data.swimlanes.length && <div className="max-w-lg rounded-xl bg-white p-6 text-sm text-slate-700">
            <h3 className="text-base font-bold text-slate-900">Nenhum macrofluxo cadastrado</h3>
            <p className="mt-2">Importe uma planilha de macrofluxo para começar. Nenhuma raia ou atividade é criada automaticamente.</p>
          </div>}
          {/* CABEÇALHO HORIZONTAL DE ETAPAS / COLUNAS COMPARTILHADAS */}
          <div className="flex items-center bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden sticky top-0 z-20">
            <div className="w-[260px] shrink-0 px-4 py-2.5 bg-slate-100 border-r border-slate-200 font-bold text-xs uppercase text-slate-600 tracking-wider flex items-center justify-between">
              <span>Raias de Obra</span>
              <span className="text-[10px] text-slate-400 font-mono">1 a {maxCol}</span>
            </div>
            <div className="flex items-center">
              {allCols.map((col) => (
                <div
                  key={col}
                  className="w-[270px] shrink-0 px-2 py-2 text-center border-r border-slate-200 bg-slate-50/70"
                >
                  <span className="font-mono text-xs font-bold text-slate-700 bg-white px-2.5 py-0.5 rounded-full border border-slate-200 shadow-2xs inline-block">
                    Etapa {col}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* LISTA DAS RAIAS DA OBRA */}
          {data.swimlanes.map((sw) => {
            const pkgCols = sw.packages.map((p) => p.colIndex ?? p.position ?? 1);
            const minCol = pkgCols.length > 0 ? Math.min(...pkgCols) : 1;
            const maxLaneCol = pkgCols.length > 0 ? Math.max(...pkgCols) : 1;

            return (
              <section
                key={sw.id}
                className="flex items-stretch bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden"
              >
                {/* CABEÇALHO LATERAL DA RAIA */}
                <div
                  className="w-[260px] shrink-0 p-4 border-r border-slate-200 flex flex-col justify-between"
                  style={{
                    backgroundColor: `${sw.color}08`,
                    borderLeft: `5px solid ${sw.color}`,
                  }}
                >
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-xl">
                        {sw.category === 'milestones'
                          ? '📌'
                          : sw.category === 'tower'
                          ? '🏢'
                          : sw.category === 'facade'
                          ? '🧱'
                          : sw.category === 'roof'
                          ? '🏠'
                          : sw.category === 'basement'
                          ? '🅿️'
                          : sw.category === 'external'
                          ? '🌳'
                          : '⚙️'}
                      </span>
                      <h3 className="font-bold text-sm uppercase text-slate-800 leading-tight">
                        {sw.name}
                      </h3>
                    </div>
                    <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                      <span className="font-semibold">{sw.packages.length}</span>
                      <span>{sw.packages.length === 1 ? 'pacote' : 'pacotes'}</span>
                      {pkgCols.length > 0 && (
                        <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded border border-slate-200 font-mono ml-auto">
                          Etapas {minCol}–{maxLaneCol}
                        </span>
                      )}
                    </div>
                  </div>

                  {sw.category !== 'milestones' && (
                    <button
                      type="button"
                      onClick={() => handleAddPackage(sw.id, maxLaneCol + 1)}
                      className="mt-3 px-2.5 py-1.5 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 text-xs font-semibold rounded-lg flex items-center justify-center gap-1.5 transition shadow-2xs hover:border-slate-300"
                    >
                      <span>+</span> Novo Pacote
                    </button>
                  )}
                </div>

                {/* TRACK DAS COLUNAS (ETAPAS 1 A maxCol) */}
                <div className="flex items-stretch overflow-visible">
                  {allCols.map((col) => {
                    const pkgsInCol = sw.packages.filter(
                      (p) => (p.colIndex ?? p.position) === col
                    );

                    // Se tem pacote nesta coluna
                    if (pkgsInCol.length > 0) {
                      return (
                        <div
                          key={col}
                          className="w-[270px] shrink-0 p-3 border-r border-slate-200/80 flex flex-col justify-center bg-slate-50/20 relative"
                        >
                          {pkgsInCol.map((pkg) => {
                            const isExpanded = Boolean(expandedJobs[pkg.id]);
                            const incomingLinks = data.interLinks.filter((l) => l.targetPackageId === pkg.id);
                            const outgoingLinks = data.interLinks.filter((l) => l.sourcePackageId === pkg.id);
                            const hasLinks = incomingLinks.length > 0 || outgoingLinks.length > 0;

                            return (
                              <div
                                key={pkg.id}
                                className={`rounded-xl border bg-white shadow-xs hover:shadow-md transition-all ${
                                  pkg.isMilestone
                                    ? 'border-indigo-300 ring-2 ring-indigo-100'
                                    : 'border-slate-200 hover:border-slate-300'
                                }`}
                              >
                                {/* Faixa superior de cor do pacote */}
                                <div
                                  className="h-1.5 rounded-t-xl"
                                  style={{ backgroundColor: pkg.color || sw.color }}
                                />

                                <div className="p-3 space-y-2">
                                  {/* Cabeçalho do Card: Coluna com Shift ◀ ▶ e Ações */}
                                  <div className="flex items-center justify-between text-[10px] font-bold text-slate-500">
                                    <div className="flex items-center gap-1 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                                      <button
                                        type="button"
                                        onClick={() => handleShiftPackageCol(sw.id, pkg.id, -1)}
                                        disabled={(pkg.colIndex || 1) <= 1}
                                        className="hover:text-slate-900 disabled:opacity-20 px-0.5 font-bold cursor-pointer"
                                        title="Mover para a etapa anterior (esquerda)"
                                      >
                                        ◀
                                      </button>
                                      <span className="font-mono text-slate-700">Etapa {col}</span>
                                      <button
                                        type="button"
                                        onClick={() => handleShiftPackageCol(sw.id, pkg.id, 1)}
                                        className="hover:text-slate-900 px-0.5 font-bold cursor-pointer"
                                        title="Mover para a próxima etapa (direita)"
                                      >
                                        ▶
                                      </button>
                                    </div>

                                    <div className="flex items-center gap-1">
                                      {!pkg.isMilestone && (
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setLinkSourceSwId(sw.id);
                                            setLinkSourcePkgId(pkg.id);
                                            setIsInterLinkModalOpen(true);
                                          }}
                                          className="p-1 hover:bg-slate-100 rounded text-indigo-600 hover:text-indigo-800"
                                          title="Conectar com outra raia (Inter-raia)"
                                        >
                                          🔗
                                        </button>
                                      )}
                                      {!pkg.isMilestone && (
                                        <button
                                          type="button"
                                          onClick={() => handleRemovePackage(sw.id, pkg.id)}
                                          className="p-1 hover:bg-rose-50 rounded text-slate-400 hover:text-rose-600"
                                          title="Excluir pacote"
                                        >
                                          ✕
                                        </button>
                                      )}
                                    </div>
                                  </div>

                                  {/* Título do Pacote */}
                                  <input
                                    type="text"
                                    value={pkg.name}
                                    onChange={(e) =>
                                      handleUpdatePackage(sw.id, pkg.id, { name: e.target.value.toUpperCase() })
                                    }
                                    className="w-full font-bold text-xs text-slate-800 bg-transparent border-b border-transparent hover:border-slate-300 focus:border-indigo-500 focus:bg-slate-50 rounded px-1 py-0.5 outline-none transition uppercase"
                                    title="Clique para editar o nome do pacote"
                                  />

                                  {/* Ritmo / Duração */}
                                  {!pkg.isMilestone && (
                                    <div className="flex items-center justify-between gap-1 text-[11px]">
                                      <span className="px-2 py-0.5 rounded-md bg-amber-50 text-amber-800 border border-amber-200/80 font-semibold font-mono text-[10px]">
                                        ⏱️ {pkg.rhythmText || `${pkg.rhythmDays}d`}
                                      </span>

                                      <button
                                        type="button"
                                        onClick={() => toggleJobs(pkg.id)}
                                        className="text-[10px] font-semibold text-slate-500 hover:text-slate-800 flex items-center gap-1"
                                      >
                                        <span>{(pkg.jobs || []).length} tarefas</span>
                                        <span>{isExpanded ? '▲' : '▼'}</span>
                                      </button>
                                    </div>
                                  )}

                                  {/* Badges de Vínculos Inter-Raias */}
                                  {hasLinks && (
                                    <div className="pt-1 border-t border-slate-100 flex flex-wrap gap-1">
                                      {incomingLinks.map((l) => (
                                        <span
                                          key={l.id}
                                          className="px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 text-[9px] font-semibold border border-indigo-200"
                                          title={l.description || 'Vínculo de entrada'}
                                        >
                                          ← Vinculado
                                        </span>
                                      ))}
                                      {outgoingLinks.map((l) => (
                                        <span
                                          key={l.id}
                                          className="px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-700 text-[9px] font-semibold border border-purple-200"
                                          title={l.description || 'Vínculo de saída'}
                                        >
                                          → Conduz
                                        </span>
                                      ))}
                                    </div>
                                  )}

                                  {/* Lista de Sub-tarefas (Jobs) Expansível */}
                                  {isExpanded && !pkg.isMilestone && (
                                    <div className="pt-2 border-t border-slate-100 space-y-1.5">
                                      <div className="max-h-36 overflow-y-auto space-y-1 pr-0.5">
                                        {(pkg.jobs || []).map((job) => (
                                          <div
                                            key={job.id}
                                            className="p-1.5 bg-slate-50 hover:bg-slate-100 rounded border border-slate-200/60 flex items-center justify-between gap-1 text-[10px]"
                                          >
                                            <span className="text-slate-700 truncate font-medium">
                                              {job.name}
                                            </span>
                                            <button
                                              type="button"
                                              onClick={() => handleRemoveJob(sw.id, pkg.id, job.id)}
                                              className="text-slate-400 hover:text-rose-600 font-bold px-1"
                                            >
                                              ✕
                                            </button>
                                          </div>
                                        ))}
                                      </div>

                                      {/* Input para adicionar nova tarefa inline */}
                                      <div className="flex items-center gap-1 pt-1">
                                        <input
                                          type="text"
                                          placeholder="+ Nova tarefa..."
                                          value={newJobInputs[pkg.id] || ''}
                                          onChange={(e) =>
                                            setNewJobInputs((prev) => ({ ...prev, [pkg.id]: e.target.value }))
                                          }
                                          onKeyDown={(e) => {
                                            if (e.key === 'Enter') handleAddJob(sw.id, pkg.id);
                                          }}
                                          className="flex-1 px-2 py-1 text-[10px] bg-slate-50 border border-slate-200 rounded text-slate-800 placeholder-slate-400 outline-none focus:bg-white focus:border-indigo-400"
                                        />
                                        <button
                                          type="button"
                                          onClick={() => handleAddJob(sw.id, pkg.id)}
                                          className="px-2 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded text-[10px] font-bold"
                                        >
                                          +
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    }

                    // Se NÃO tem pacote nesta coluna:
                    const isBeforeStart = col < minCol;
                    const isBetween = col > minCol && col < maxLaneCol;

                    return (
                      <div
                        key={col}
                        className="w-[270px] shrink-0 border-r border-slate-200/50 flex items-center justify-center relative group p-2"
                      >
                        {/* Linha de conexão horizontal sólida se for intervalo entre pacotes */}
                        {isBetween && (
                          <div className="absolute inset-x-0 h-0.5 bg-slate-200 top-1/2 -translate-y-1/2 pointer-events-none" />
                        )}

                        {/* Linha tracejada suave se for antes do início da raia */}
                        {isBeforeStart && (
                          <div className="absolute inset-x-2 border-b border-dashed border-slate-200 top-1/2 -translate-y-1/2 pointer-events-none" />
                        )}

                        {/* Botão de adicionar pacote nesta coluna específica que aparece no hover */}
                        {sw.category !== 'milestones' && (
                          <button
                            type="button"
                            onClick={() => handleAddPackage(sw.id, col)}
                            className="opacity-0 group-hover:opacity-100 px-3 py-1 bg-white hover:bg-indigo-50 border border-slate-300 hover:border-indigo-300 text-slate-600 hover:text-indigo-700 text-[10px] font-bold rounded-full shadow-2xs transition z-10 flex items-center gap-1 cursor-pointer"
                            title={`Inserir pacote na Etapa ${col}`}
                          >
                            <span>+</span> Inserir na Etapa {col}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </main>

      {/* =====================================================================
          3. MODAL: VÍNCULOS INTER-RAIAS (TEMA CLARO)
         ===================================================================== */}
      {isInterLinkModalOpen && (
        <div className="fixed inset-0 z-60 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white text-slate-800 rounded-2xl border border-slate-200 w-full max-w-2xl overflow-hidden shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="px-6 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xl">🔗</span>
                <h3 className="font-bold text-base text-slate-800">
                  Vínculos Inter-Raias
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setIsInterLinkModalOpen(false)}
                className="w-8 h-8 rounded-lg bg-slate-200 hover:bg-slate-300 text-slate-600 flex items-center justify-center font-bold"
              >
                ✕
              </button>
            </div>

            <div className="p-6 space-y-5">
              {/* FORMULÁRIO DE NOVO VÍNCULO */}
              <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
                <span className="font-bold uppercase text-slate-600 text-xs block">
                  Criar Novo Vínculo de Precedência
                </span>

                <div className="grid grid-cols-2 gap-3 text-xs">
                  {/* Origem */}
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold uppercase text-slate-500">
                      1. Raia de Origem (Predecessora):
                    </label>
                    <select
                      value={linkSourceSwId}
                      onChange={(e) => {
                        setLinkSourceSwId(e.target.value);
                        const sw = data.swimlanes.find((s) => s.id === e.target.value);
                        setLinkSourcePkgId(sw?.packages[0]?.id || '');
                      }}
                      className="w-full p-2 bg-white border border-slate-300 rounded-lg text-slate-800 outline-none"
                    >
                      <option value="">Selecione a raia...</option>
                      {data.swimlanes.map((sw) => (
                        <option key={sw.id} value={sw.id}>
                          {sw.name}
                        </option>
                      ))}
                    </select>

                    <label className="text-[10px] font-bold uppercase text-slate-500">
                      Pacote de Origem:
                    </label>
                    <select
                      value={linkSourcePkgId}
                      onChange={(e) => setLinkSourcePkgId(e.target.value)}
                      className="w-full p-2 bg-white border border-slate-300 rounded-lg text-slate-800 outline-none"
                    >
                      <option value="">Selecione o pacote...</option>
                      {(data.swimlanes.find((s) => s.id === linkSourceSwId)?.packages || []).map((pkg) => (
                        <option key={pkg.id} value={pkg.id}>
                          {pkg.name} (Etapa {pkg.colIndex || pkg.position})
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Destino */}
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold uppercase text-slate-500">
                      2. Raia de Destino (Sucessora):
                    </label>
                    <select
                      value={linkTargetSwId}
                      onChange={(e) => {
                        setLinkTargetSwId(e.target.value);
                        const sw = data.swimlanes.find((s) => s.id === e.target.value);
                        setLinkTargetPkgId(sw?.packages[0]?.id || '');
                      }}
                      className="w-full p-2 bg-white border border-slate-300 rounded-lg text-slate-800 outline-none"
                    >
                      <option value="">Selecione a raia...</option>
                      {data.swimlanes.map((sw) => (
                        <option key={sw.id} value={sw.id}>
                          {sw.name}
                        </option>
                      ))}
                    </select>

                    <label className="text-[10px] font-bold uppercase text-slate-500">
                      Pacote de Destino:
                    </label>
                    <select
                      value={linkTargetPkgId}
                      onChange={(e) => setLinkTargetPkgId(e.target.value)}
                      className="w-full p-2 bg-white border border-slate-300 rounded-lg text-slate-800 outline-none"
                    >
                      <option value="">Selecione o pacote...</option>
                      {(data.swimlanes.find((s) => s.id === linkTargetSwId)?.packages || []).map((pkg) => (
                        <option key={pkg.id} value={pkg.id}>
                          {pkg.name} (Etapa {pkg.colIndex || pkg.position})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Tipo de Vínculo e Defasagem */}
                <div className="grid grid-cols-2 gap-3 text-xs pt-1">
                  <div>
                    <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">
                      Regra de Relação:
                    </label>
                    <select
                      value={linkType}
                      onChange={(e) => setLinkType(e.target.value as any)}
                      className="w-full p-2 bg-white border border-slate-300 rounded-lg text-slate-800 outline-none"
                    >
                      <option value="finish_to_start">Término para Início (Fim da Origem libera Destino)</option>
                      <option value="floor_lag">Defasagem de Pavimentos (Ex: Destino inicia N pavimentos após Origem)</option>
                      <option value="day_lag">Defasagem em Dias (Ex: Inicia N dias após o término)</option>
                    </select>
                  </div>

                  {linkType !== 'finish_to_start' && (
                    <div>
                      <label className="text-[10px] font-bold uppercase text-slate-500 block mb-1">
                        Valor da Defasagem:
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={linkLagValue}
                        onChange={(e) => setLinkLagValue(Math.max(1, Number(e.target.value) || 1))}
                        className="w-full p-2 bg-white border border-slate-300 rounded-lg font-mono font-bold text-slate-800 text-center"
                      />
                    </div>
                  )}
                </div>

                <input
                  type="text"
                  placeholder="Descrição da regra (ex: Fachada inicia após 5 pavimentos de Estrutura)"
                  value={linkDescription}
                  onChange={(e) => setLinkDescription(e.target.value)}
                  className="w-full p-2 bg-white border border-slate-300 rounded-lg text-slate-800 text-xs outline-none"
                />

                <button
                  type="button"
                  onClick={handleAddInterLink}
                  className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs uppercase rounded-lg transition"
                >
                  + Confirmar Vínculo Inter-Raia
                </button>
              </div>

              {/* LISTA DE VÍNCULOS EXISTENTES */}
              <div className="space-y-2 pt-1">
                <span className="font-bold uppercase text-slate-600 text-xs block">
                  Vínculos Cadastrados ({data.interLinks.length})
                </span>
                {data.interLinks.length === 0 ? (
                  <p className="text-slate-400 text-center py-4 text-xs">Nenhum vínculo inter-raia cadastrado.</p>
                ) : (
                  <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                    {data.interLinks.map((l) => {
                      const sSw = data.swimlanes.find((s) => s.id === l.sourceSwimlaneId);
                      const sPkg = sSw?.packages.find((p) => p.id === l.sourcePackageId);
                      const tSw = data.swimlanes.find((s) => s.id === l.targetSwimlaneId);
                      const tPkg = tSw?.packages.find((p) => p.id === l.targetPackageId);

                      return (
                        <div
                          key={l.id}
                          className="p-3 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between gap-3 text-xs"
                        >
                          <div>
                            <div className="font-bold text-slate-800 flex items-center gap-2">
                              <span className="text-amber-700 font-semibold">{sPkg?.name || 'Origem'}</span>
                              <span className="text-slate-400">➔</span>
                              <span className="text-indigo-700 font-semibold">{tPkg?.name || 'Destino'}</span>
                            </div>
                            <div className="text-[11px] text-slate-500 mt-0.5">
                              {l.description || (l.type === 'floor_lag' ? `Após ${l.lagValue} pavimentos` : 'Fim para Início')}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleRemoveInterLink(l.id)}
                            className="px-2.5 py-1 text-rose-600 hover:bg-rose-50 rounded font-semibold text-xs border border-transparent hover:border-rose-200"
                          >
                            Excluir
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

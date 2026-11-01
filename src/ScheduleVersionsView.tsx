import React, { useState, useMemo } from 'react';
import {
  loadScheduleVersions,
  createNewScheduleVersion,
  setVersionAsBaseline,
  activateScheduleVersion,
  type ScheduleVersion,
} from './scheduleVersions';

interface ScheduleVersionsViewProps {
  projectId: string;
  projectName?: string;
  currentSnapshot: {
    cronogramaInicial: any[];
    floors: string[];
    allFloorsData: Record<string, any>;
    weights?: Record<string, Record<string, number>>;
    teams?: string[];
    matrices?: any[];
  };
  onApplyVersion: (snapshot: any, versionName: string) => Promise<void>;
}

function formatDateBR(isoStr?: string): string {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    return d.toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoStr;
  }
}

export const ScheduleVersionsView: React.FC<ScheduleVersionsViewProps> = ({
  projectId,
  projectName = 'Obra Principal',
  currentSnapshot,
  onApplyVersion,
}) => {
  const [versions, setVersions] = useState<ScheduleVersion[]>(() =>
    loadScheduleVersions(projectId, currentSnapshot)
  );

  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const [newVersionName, setNewVersionName] = useState('');
  const [newVersionDesc, setNewVersionDesc] = useState('');
  const [isBaselineCheck, setIsBaselineCheck] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');

  const baselineVersion = useMemo(() => {
    return versions.find((v) => v.isBaseline) || versions[0] || null;
  }, [versions]);

  const activeVersion = useMemo(() => {
    return versions.find((v) => v.isActive) || versions[0] || null;
  }, [versions]);

  const handleCreateVersion = () => {
    const { versions: updated } = createNewScheduleVersion(
      projectId,
      newVersionName || `Revisão 0${versions.length + 1}`,
      newVersionDesc,
      isBaselineCheck,
      currentSnapshot
    );
    setVersions(updated);
    setIsNewModalOpen(false);
    setNewVersionName('');
    setNewVersionDesc('');
    setIsBaselineCheck(false);
  };

  const handleSetBaseline = (versionId: string) => {
    const updated = setVersionAsBaseline(projectId, versionId);
    setVersions(updated);
  };

  const handleActivate = async (version: ScheduleVersion) => {
    const { versions: updated } = activateScheduleVersion(projectId, version.id);
    setVersions(updated);
    if (version.snapshot) {
      await onApplyVersion(version.snapshot, version.name);
    }
  };

  // Comparação de variância entre versão Ativa e Linha de Base
  const varianceList = useMemo(() => {
    if (!baselineVersion?.snapshot?.cronogramaInicial || !currentSnapshot?.cronogramaInicial) {
      return [];
    }

    const baseMap = new Map<string, any>();
    for (const act of baselineVersion.snapshot.cronogramaInicial) {
      const id = String(act.id || act.tarefaId || act.nome || '');
      if (id) baseMap.set(id, act);
    }

    const rows: Array<{
      id: string;
      name: string;
      floor: string;
      baseStart: string;
      baseEnd: string;
      baseDur: number;
      currStart: string;
      currEnd: string;
      currDur: number;
      varianceDays: number;
      status: 'delayed' | 'ontime' | 'accelerated';
    }> = [];

    for (const act of currentSnapshot.cronogramaInicial) {
      const id = String(act.id || act.tarefaId || act.nome || '');
      const bAct = baseMap.get(id);
      if (!bAct) continue;

      const currS = String(act.startDate || act.start || act.inicio || '').slice(0, 10);
      const currE = String(act.endDate || act.finish || act.fim || '').slice(0, 10);
      const baseS = String(bAct.startDate || bAct.start || bAct.inicio || '').slice(0, 10);
      const baseE = String(bAct.endDate || bAct.finish || bAct.fim || '').slice(0, 10);

      const currDur = Number(act.duration || 1);
      const baseDur = Number(bAct.duration || 1);

      let diffDays = 0;
      if (currE && baseE) {
        const dCurr = new Date(currE + 'T12:00:00Z').getTime();
        const dBase = new Date(baseE + 'T12:00:00Z').getTime();
        diffDays = Math.round((dCurr - dBase) / (1000 * 60 * 60 * 24));
      }

      let status: 'delayed' | 'ontime' | 'accelerated' = 'ontime';
      if (diffDays > 0) status = 'delayed';
      else if (diffDays < 0) status = 'accelerated';

      rows.push({
        id,
        name: act.name || act.serviceName || act.nome || id,
        floor: act.floorName || act.pavimento || '-',
        baseStart: baseS,
        baseEnd: baseE,
        baseDur,
        currStart: currS,
        currEnd: currE,
        currDur,
        varianceDays: diffDays,
        status,
      });
    }

    return rows;
  }, [baselineVersion, currentSnapshot]);

  const delayedCount = varianceList.filter((v) => v.status === 'delayed').length;
  const acceleratedCount = varianceList.filter((v) => v.status === 'accelerated').length;
  const onTimeCount = varianceList.filter((v) => v.status === 'ontime').length;

  return (
    <div className="space-y-6 animate-in fade-in duration-300 pb-16">
      {/* HEADER DA TELA */}
      <div className="bg-white p-5 rounded-2xl shadow-md border border-slate-200 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-2xl">🏷️</span>
            <h2 className="text-lg font-black uppercase tracking-tight text-slate-800">
              Versões de Cronograma & Linha de Base
            </h2>
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-indigo-100 text-indigo-800 border border-indigo-200">
              {versions.length} {versions.length === 1 ? 'Versão' : 'Versões'}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Gerencie revisões congeladas da obra, estabeleça a Linha de Base Oficial e acompanhe desvios de datas.
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setNewVersionName(`Revisão 0${versions.length + 1} - Reprogramação`);
            setNewVersionDesc('');
            setIsBaselineCheck(false);
            setIsNewModalOpen(true);
          }}
          className="px-4 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs uppercase tracking-wider shadow-sm transition flex items-center gap-2 active:scale-95"
        >
          <span>💾</span> Congelar Versão Atual
        </button>
      </div>

      {/* CARDS DE RESUMO: BASELINE E VERSÃO ATIVA */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Card 1: Linha de Base Oficial */}
        <div className="bg-amber-50/70 p-4 rounded-2xl border-2 border-amber-300/80 shadow-xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-black uppercase tracking-wider text-amber-800">
              ⭐ Linha de Base Oficial
            </span>
            <span className="text-xs">🔒 Congelada</span>
          </div>
          <h3 className="font-bold text-slate-900 text-sm">{baselineVersion?.name || 'Nenhuma'}</h3>
          <p className="text-[11px] text-slate-600 line-clamp-2">
            {baselineVersion?.description || 'Referência inicial adotada para o cálculo da Curva S e prazos contratuais.'}
          </p>
          <div className="text-[10px] text-slate-500 font-mono pt-1 border-t border-amber-200/60">
            Criada em: {formatDateBR(baselineVersion?.createdAt)}
          </div>
        </div>

        {/* Card 2: Versão Ativa no Cronograma */}
        <div className="bg-emerald-50/70 p-4 rounded-2xl border-2 border-emerald-300/80 shadow-xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-black uppercase tracking-wider text-emerald-800">
              🟢 Em Edição Ativa
            </span>
            <span className="text-xs">✏️ Editável</span>
          </div>
          <h3 className="font-bold text-slate-900 text-sm">{activeVersion?.name || 'Versão Atual'}</h3>
          <p className="text-[11px] text-slate-600 line-clamp-2">
            {activeVersion?.description || 'Versão atualmente carregada na Linha de Balanço e no planejamento semanal.'}
          </p>
          <div className="text-[10px] text-slate-500 font-mono pt-1 border-t border-emerald-200/60">
            Criada em: {formatDateBR(activeVersion?.createdAt)}
          </div>
        </div>

        {/* Card 3: Variância em Relação à Base */}
        <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 shadow-xs space-y-2">
          <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">
            📊 Desvios em Relação à Base
          </span>
          <div className="flex items-center justify-between gap-2 pt-1">
            <div className="text-center flex-1 p-1.5 bg-rose-50 rounded-xl border border-rose-200">
              <span className="text-xs font-black text-rose-700 block">{delayedCount}</span>
              <span className="text-[9px] uppercase font-bold text-rose-600">Atrasadas</span>
            </div>
            <div className="text-center flex-1 p-1.5 bg-slate-100 rounded-xl border border-slate-200">
              <span className="text-xs font-black text-slate-700 block">{onTimeCount}</span>
              <span className="text-[9px] uppercase font-bold text-slate-600">No Prazo</span>
            </div>
            <div className="text-center flex-1 p-1.5 bg-emerald-50 rounded-xl border border-emerald-200">
              <span className="text-xs font-black text-emerald-700 block">{acceleratedCount}</span>
              <span className="text-[9px] uppercase font-bold text-emerald-600">Adiantadas</span>
            </div>
          </div>
          <p className="text-[10px] text-slate-500 text-center">
            {varianceList.length} atividades mapeadas entre as duas versões.
          </p>
        </div>
      </div>

      {/* LISTA DE TODAS AS VERSÕES CADASTRADAS */}
      <div className="bg-white rounded-2xl shadow-md border border-slate-200 overflow-hidden space-y-4 p-5">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 border-b pb-4">
          <div>
            <h3 className="font-bold text-slate-800 text-sm">Histórico de Versões Salvas</h3>
            <p className="text-xs text-slate-500">
              Selecione uma versão para restaurar no cronograma ativo ou fixar como a nova linha de base.
            </p>
          </div>
          <input
            type="text"
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            placeholder="Filtrar versão..."
            className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs w-56 outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        <div className="divide-y divide-slate-100">
          {versions
            .filter((v) => !searchFilter.trim() || v.name.toLowerCase().includes(searchFilter.toLowerCase().trim()))
            .map((v) => {
              const isBase = v.isBaseline;
              const isAct = v.isActive;
              const taskCount = v.snapshot?.cronogramaInicial?.length || 0;

              return (
                <div
                  key={v.id}
                  className={`p-4 rounded-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4 transition-colors ${
                    isAct ? 'bg-emerald-50/30' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-900 text-sm">{v.name}</span>
                      {isBase && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase bg-amber-100 text-amber-800 border border-amber-300">
                          ⭐ Linha de Base
                        </span>
                      )}
                      {isAct && (
                        <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase bg-emerald-100 text-emerald-800 border border-emerald-300">
                          🟢 Ativa
                        </span>
                      )}
                    </div>
                    {v.description && <p className="text-xs text-slate-600">{v.description}</p>}
                    <div className="flex items-center gap-4 text-[11px] text-slate-400 font-mono">
                      <span>📅 Criada em: {formatDateBR(v.createdAt)}</span>
                      <span>📦 {taskCount} atividades</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {!isAct && (
                      <button
                        type="button"
                        onClick={() => handleActivate(v)}
                        className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs shadow-xs transition"
                      >
                        Carregar no Cronograma
                      </button>
                    )}
                    {!isBase && (
                      <button
                        type="button"
                        onClick={() => handleSetBaseline(v.id)}
                        className="px-3 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 font-bold text-xs transition"
                        title="Tornar esta versão a Linha de Base Oficial"
                      >
                        ⭐ Fixar como Base
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      {/* TABELA DE VARIÂNCIA DETALHADA ENTRE CRONOGRAMA ATIVO E LINHA DE BASE */}
      {varianceList.length > 0 && (
        <div className="bg-white rounded-2xl shadow-md border border-slate-200 overflow-hidden p-5 space-y-4">
          <div className="flex justify-between items-center border-b pb-3">
            <div>
              <h3 className="font-bold text-slate-800 text-sm">
                Comparativo Detalhado de Prazos (Ativo vs Linha de Base)
              </h3>
              <p className="text-xs text-slate-500">
                Comparação de datas de término entre a versão ativa e a Linha de Base Oficial.
              </p>
            </div>
          </div>

          <div className="overflow-x-auto max-h-96 scrollbar-thin">
            <table className="w-full text-left text-xs border-separate border-spacing-0">
              <thead className="bg-slate-900 text-white sticky top-0 z-10">
                <tr>
                  <th className="py-2 px-3 border-b border-r border-slate-800">Atividade / Serviço</th>
                  <th className="py-2 px-2 border-b border-r border-slate-800">Local</th>
                  <th className="py-2 px-2 border-b border-r border-slate-800 text-center">Início Base</th>
                  <th className="py-2 px-2 border-b border-r border-slate-800 text-center">Fim Base</th>
                  <th className="py-2 px-2 border-b border-r border-slate-800 text-center">Início Atual</th>
                  <th className="py-2 px-2 border-b border-r border-slate-800 text-center">Fim Atual</th>
                  <th className="py-2 px-2 border-b border-r border-slate-800 text-center">Desvio (Dias)</th>
                  <th className="py-2 px-2 border-b border-slate-800 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 font-mono">
                {varianceList.slice(0, 50).map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50 transition-colors">
                    <td className="py-1.5 px-3 border-b border-r border-slate-200 font-sans font-medium text-slate-800">
                      {r.name}
                    </td>
                    <td className="py-1.5 px-2 border-b border-r border-slate-200 text-slate-600">{r.floor}</td>
                    <td className="py-1.5 px-2 border-b border-r border-slate-200 text-center text-slate-500">
                      {r.baseStart}
                    </td>
                    <td className="py-1.5 px-2 border-b border-r border-slate-200 text-center text-slate-500">
                      {r.baseEnd}
                    </td>
                    <td className="py-1.5 px-2 border-b border-r border-slate-200 text-center font-bold text-slate-800">
                      {r.currStart}
                    </td>
                    <td className="py-1.5 px-2 border-b border-r border-slate-200 text-center font-bold text-slate-800">
                      {r.currEnd}
                    </td>
                    <td
                      className={`py-1.5 px-2 border-b border-r border-slate-200 text-center font-bold ${
                        r.varianceDays > 0 ? 'text-rose-600' : r.varianceDays < 0 ? 'text-emerald-600' : 'text-slate-400'
                      }`}
                    >
                      {r.varianceDays > 0 ? `+${r.varianceDays}d` : r.varianceDays < 0 ? `${r.varianceDays}d` : '0d'}
                    </td>
                    <td className="py-1.5 px-2 border-b border-slate-200 text-center font-sans font-bold text-[10px]">
                      {r.status === 'delayed' && (
                        <span className="px-2 py-0.5 rounded bg-rose-100 text-rose-800">Atrasada</span>
                      )}
                      {r.status === 'ontime' && (
                        <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600">No Prazo</span>
                      )}
                      {r.status === 'accelerated' && (
                        <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">Adiantada</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MODAL: SALVAR NOVA VERSÃO */}
      {isNewModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl border border-slate-200 space-y-4">
            <div className="flex items-center justify-between border-b pb-3">
              <h3 className="font-black text-slate-900 text-sm uppercase tracking-wider flex items-center gap-1.5">
                <span>💾</span> Salvar Nova Versão de Cronograma
              </h3>
              <button
                type="button"
                onClick={() => setIsNewModalOpen(false)}
                className="text-slate-400 hover:text-slate-700 text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="font-bold text-slate-700 block mb-1">Nome da Versão:</label>
                <input
                  type="text"
                  value={newVersionName}
                  onChange={(e) => setNewVersionName(e.target.value)}
                  placeholder={`Ex: Revisão 0${versions.length + 1} - Aceleração`}
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 font-medium outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="font-bold text-slate-700 block mb-1">Descrição / Justificativa:</label>
                <textarea
                  value={newVersionDesc}
                  onChange={(e) => setNewVersionDesc(e.target.value)}
                  rows={3}
                  placeholder="Ex: Reprogramação após atraso de insumos nas fundações..."
                  className="w-full bg-slate-50 border border-slate-300 rounded-lg p-2 font-medium outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                />
              </div>

              <label className="flex items-center gap-2 p-3 bg-amber-50 rounded-xl border border-amber-200 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={isBaselineCheck}
                  onChange={(e) => setIsBaselineCheck(e.target.checked)}
                  className="w-4 h-4 rounded text-amber-600 focus:ring-0 cursor-pointer"
                />
                <div>
                  <span className="font-bold text-amber-900 block">Definir como Nova Linha de Base Oficial</span>
                  <span className="text-[11px] text-amber-700">
                    A Curva S e as comparações na Linha de Balanço passarão a utilizar esta versão como referência zero.
                  </span>
                </div>
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t">
              <button
                type="button"
                onClick={() => setIsNewModalOpen(false)}
                className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 font-bold text-xs"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={handleCreateVersion}
                className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-xs shadow-md transition"
              >
                Salvar Versão
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

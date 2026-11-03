import { cloudStorage } from './firebaseDocuments';
import React, { useState, useMemo } from 'react';
import type {
  BudgetItem,
  ProjectBudgetState,
  PonderationMode,
  LinkedScheduleItemDetail,
  BudgetLinkingRow,
} from './budgetLinking';
import {
  distributeWeightsEqually,
  distributeWeightsByTime,
  distributeWeightsByQuantity,
  distributeWeightsByArea,
  validateWeightsSum,
  getEffectiveBudgetState,
  parseBudgetRows,
  parseBudgetLinkingRows,
  applyImportedLinksToBudget,
} from './budgetLinking';
import type {
  LobActivity,
  ScheduleFloor,
  ScheduleServicePackage,
  ReplicationGroup,
} from './longTermSchedule';

interface BudgetLinkingViewProps {
  projectId: string;
  projectName: string;
  activities: LobActivity[];
  floors: ScheduleFloor[];
  services: ScheduleServicePackage[];
  replicationGroups: ReplicationGroup[];
  existingWeights: Record<string, Record<string, number>>;
  onBack: () => void;
  onSaveWeightsAndCosts: (
    budgetState: ProjectBudgetState,
    updatedFloors?: ScheduleFloor[]
  ) => void | Promise<void>;
}

export const BudgetLinkingView: React.FC<BudgetLinkingViewProps> = ({
  projectId,
  projectName,
  activities,
  floors,
  services,
  replicationGroups,
  existingWeights,
  onBack,
  onSaveWeightsAndCosts,
}) => {
  // Estado principal do orçamento
  const [budgetState, setBudgetState] = useState<ProjectBudgetState>(() => {
    return getEffectiveBudgetState(projectId, activities, floors, services);
  });

  // Filtros da tabela de orçamento (Esquerda)
  const [budgetSearch, setBudgetSearch] = useState('');
  const [filterUnlinkedBudget, setFilterUnlinkedBudget] = useState(false);
  const [filterNot100Budget, setFilterNot100Budget] = useState(false);
  const [levelFilter, setLevelFilter] = useState<number | 'all'>('all');
  const [selectedBudgetItemIds, setSelectedBudgetItemIds] = useState<string[]>([]);

  // Filtros da lista de cronograma (Direita)
  const [scheduleSearch, setScheduleSearch] = useState('');
  const [filterUnlinkedSchedule, setFilterUnlinkedSchedule] = useState(false);
  const [selectedScheduleIds, setSelectedScheduleIds] = useState<string[]>([]);
  const [expandedPackages, setExpandedPackages] = useState<Record<string, boolean>>({});

  // Modais
  const [isPonderationOpen, setIsPonderationOpen] = useState(false);
  const [isAreasModalOpen, setIsAreasModalOpen] = useState(false);
  const [isImportBudgetOpen, setIsImportBudgetOpen] = useState(false);
  const [isImportLinksOpen, setIsImportLinksOpen] = useState(false);
  const [activePonderationTab, setActivePonderationTab] = useState<string>('');
  const [localFloors, setLocalFloors] = useState<ScheduleFloor[]>(floors);

  // Mapeamentos rápidos
  const floorById = useMemo(() => new Map(localFloors.map((f) => [f.id, f])), [localFloors]);
  const serviceById = useMemo(() => new Map(services.map((s) => [s.id, s])), [services]);
  const activityById = useMemo(() => new Map(activities.map((a) => [a.id, a])), [activities]);

  // Totalizadores do orçamento
  const stats = useMemo(() => {
    let totalItems = 0;
    let linkedItems = 0;
    let unlinkedItems = 0;
    let totalBudgetVal = 0;
    let totalLinkedVal = 0;

    budgetState.items.forEach((item) => {
      if (item.level === 1) totalBudgetVal += item.totalCost || 0;
      if (item.isLeaf) {
        totalItems++;
        const isLinked = (item.linkedScheduleIds || []).length > 0;
        if (isLinked) {
          linkedItems++;
          totalLinkedVal += item.totalCost || 0;
        } else {
          unlinkedItems++;
        }
      }
    });

    if (totalBudgetVal === 0) {
      totalBudgetVal = budgetState.items
        .filter((i) => i.isLeaf)
        .reduce((acc, i) => acc + (i.totalCost || 0), 0);
    }

    return {
      totalItems,
      linkedItems,
      unlinkedItems,
      totalBudgetVal,
      totalLinkedVal,
      percentLinked: totalItems > 0 ? Math.round((linkedItems / totalItems) * 100) : 0,
    };
  }, [budgetState]);

  // Itens de orçamento filtrados
  const filteredBudgetItems = useMemo(() => {
    return budgetState.items.filter((item) => {
      if (levelFilter !== 'all' && item.level !== levelFilter) return false;
      if (budgetSearch) {
        const q = budgetSearch.toLowerCase();
        const matchCode = item.eapCode.toLowerCase().includes(q);
        const matchName = item.name.toLowerCase().includes(q);
        if (!matchCode && !matchName) return false;
      }
      const linkedCount = (item.linkedScheduleIds || []).length;
      if (filterUnlinkedBudget && linkedCount > 0) return false;
      if (filterNot100Budget) {
        if (linkedCount === 0) return false;
        const weights = Object.values(item.weights || {});
        const sum = weights.reduce((acc, w) => acc + (w || 0), 0);
        if (Math.abs(100 - sum) <= 0.05) return false;
      }
      return true;
    });
  }, [budgetState.items, levelFilter, budgetSearch, filterUnlinkedBudget, filterNot100Budget]);

  // Agrupamento de atividades do cronograma por pacote de serviço
  const schedulePackages = useMemo(() => {
    return services.map((svc) => {
      const svcActs = activities.filter((a) => a.serviceId === svc.id);
      const isPkgLinked = svcActs.some((act) =>
        budgetState.items.some((b) => (b.linkedScheduleIds || []).includes(act.id))
      );
      return {
        service: svc,
        activities: svcActs,
        isLinked: isPkgLinked,
      };
    });
  }, [services, activities, budgetState.items]);

  // Filtra pacotes do cronograma
  const filteredSchedulePackages = useMemo(() => {
    return schedulePackages.filter((pkg) => {
      if (filterUnlinkedSchedule && pkg.isLinked) return false;
      if (scheduleSearch) {
        const q = scheduleSearch.toLowerCase();
        const matchPkg = pkg.service.name.toLowerCase().includes(q);
        const matchAct = pkg.activities.some((a) => {
          const flr = floorById.get(a.floorId);
          return flr?.name.toLowerCase().includes(q);
        });
        if (!matchPkg && !matchAct) return false;
      }
      return true;
    });
  }, [schedulePackages, filterUnlinkedSchedule, scheduleSearch, floorById]);

  // Ação de vincular seleções
  const handleLinkSelections = () => {
    if (selectedBudgetItemIds.length === 0 || selectedScheduleIds.length === 0) return;

    // Converte seleções que podem ser de pacote para IDs de atividade
    const expandedScheduleActIds = new Set<string>();
    selectedScheduleIds.forEach((id) => {
      if (id.startsWith('pkg_')) {
        const svcId = id.replace('pkg_', '');
        activities.filter((a) => a.serviceId === svcId).forEach((a) => expandedScheduleActIds.add(a.id));
      } else {
        expandedScheduleActIds.add(id);
      }
    });

    const targetActIds = Array.from(expandedScheduleActIds);
    if (targetActIds.length === 0) return;

    setBudgetState((prev) => {
      const nextItems = prev.items.map((item) => {
        if (!selectedBudgetItemIds.includes(item.id)) return item;

        // Une os novos IDs aos já existentes sem duplicatas
        const combinedIds = Array.from(new Set([...(item.linkedScheduleIds || []), ...targetActIds]));
        const equalWeights = distributeWeightsEqually(combinedIds.length);
        const newWeights: Record<string, number> = {};
        combinedIds.forEach((actId, idx) => {
          newWeights[actId] = equalWeights[idx];
        });

        return {
          ...item,
          linkedScheduleIds: combinedIds,
          weights: newWeights,
        };
      });

      const updated = {
        ...prev,
        items: nextItems,
        lastUpdated: new Date().toISOString(),
      };
      try {
        cloudStorage.setItem(`curtoprazo_budget_${projectId}`, JSON.stringify(updated));
      } catch (_) {}
      return updated;
    });

    setSelectedScheduleIds([]);
  };

  // Abre modal de ponderação
  const handleOpenPonderation = () => {
    const targetIds =
      selectedBudgetItemIds.length > 0
        ? selectedBudgetItemIds
        : budgetState.items.filter((i) => i.isLeaf && (i.linkedScheduleIds || []).length > 0).map((i) => i.id);

    if (targetIds.length === 0) return;
    setActivePonderationTab(targetIds[0]);
    setIsPonderationOpen(true);
  };

  return (
    <div className="flex flex-col h-full bg-slate-100 text-slate-800">
      {/* 1. BARRA SUPERIOR DE GOVERNANÇA */}
      <div className="bg-white border-b border-slate-200 px-6 py-4 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-xs">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="p-2 rounded-xl text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition"
            title="Voltar ao Cronograma / Linha de Balanço"
          >
            ← Voltar
          </button>
          <div className="h-6 w-px bg-slate-200" />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xl">💰</span>
              <h1 className="text-lg font-black text-slate-900 tracking-tight">
                Vinculando Orçamento ao Cronograma
              </h1>
              <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-800">
                {stats.percentLinked}% Vinculado
              </span>
            </div>
            <p className="text-xs text-slate-500">
              Faça a correspondência e ponderação de pesos e custos entre o orçamento executivo e as tarefas da obra.
            </p>
          </div>
        </div>

        {/* Botões de Ação Direta */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setIsAreasModalOpen(true)}
            className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs rounded-xl transition flex items-center gap-1.5"
            title="Configurar áreas em m² dos pavimentos e lotes"
          >
            <span>📐</span> Áreas dos Lotes
          </button>

          <button
            type="button"
            onClick={() => setIsImportBudgetOpen(true)}
            className="px-3 py-2 bg-white hover:bg-slate-50 border border-slate-300 text-slate-800 font-bold text-xs rounded-xl transition shadow-xs flex items-center gap-1.5 active:scale-95"
            title="Importar planilha de orçamento executivo (Nível, Código, Descrição, Material, Mão de Obra, Total)"
          >
            <span>📥</span> Importar Orçamento
          </button>

          <button
            type="button"
            onClick={() => setIsImportLinksOpen(true)}
            className="px-3 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 font-bold text-xs rounded-xl transition shadow-xs flex items-center gap-1.5 active:scale-95"
            title="Importar planilha de vínculos entre orçamento e cronograma"
          >
            <span>🔗</span> Importar Vínculos
          </button>



          <button
            type="button"
            onClick={handleLinkSelections}
            disabled={selectedBudgetItemIds.length === 0 || selectedScheduleIds.length === 0}
            className={`px-4 py-2 rounded-xl font-black text-xs uppercase tracking-wider transition flex items-center gap-1.5 shadow-sm ${
              selectedBudgetItemIds.length > 0 && selectedScheduleIds.length > 0
                ? 'bg-indigo-600 hover:bg-indigo-700 text-white active:scale-95'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed'
            }`}
          >
            <span>🔗</span> Vincular ({selectedBudgetItemIds.length} ⇄ {selectedScheduleIds.length})
          </button>

          <button
            type="button"
            onClick={handleOpenPonderation}
            className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white font-black text-xs uppercase tracking-wider rounded-xl transition shadow-sm active:scale-95 flex items-center gap-1.5"
          >
            <span>⚖️</span> Ponderar Pesos & Custos
          </button>

          <button
            type="button"
            onClick={async () => {
              try {
                await cloudStorage.saveItem(`curtoprazo_budget_${projectId}`, JSON.stringify(budgetState));
                await onSaveWeightsAndCosts(budgetState, localFloors);
              } catch (error) { alert(error instanceof Error ? error.message : 'Não foi possível salvar o orçamento no Firebase.'); }
            }}
            className="px-4 py-2 bg-slate-900 hover:bg-black text-white font-black text-xs uppercase tracking-wider rounded-xl transition shadow-sm"
          >
            Salvar e Aplicar
          </button>
        </div>
      </div>

      {/* 2. BARRA DE TOTALIZADORES E FILTROS */}
      <div className="bg-slate-50 border-b border-slate-200 px-6 py-2.5 flex flex-wrap items-center justify-between gap-4 text-xs">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="text-slate-400 font-medium">Orçamento Total:</span>
            <span className="font-mono font-black text-slate-900">
              R$ {stats.totalBudgetVal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-400 font-medium">Itens Folha:</span>
            <span className="font-bold text-slate-800">{stats.totalItems}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-400 font-medium">Vinculados:</span>
            <span className="font-bold text-emerald-700">
              {stats.linkedItems} ({stats.percentLinked}%)
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-slate-400 font-medium">Desvinculados:</span>
            <span className="font-bold text-amber-700">{stats.unlinkedItems}</span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={filterUnlinkedBudget}
              onChange={(e) => setFilterUnlinkedBudget(e.target.checked)}
              className="rounded text-indigo-600 focus:ring-0"
            />
            <span className="text-[11px] font-bold text-slate-600">Apenas Desvinculados</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={filterNot100Budget}
              onChange={(e) => setFilterNot100Budget(e.target.checked)}
              className="rounded text-indigo-600 focus:ring-0"
            />
            <span className="text-[11px] font-bold text-slate-600">Vínculos ≠ 100%</span>
          </label>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-bold text-slate-400">Nível:</span>
            <select
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
              className="bg-white border border-slate-300 rounded-lg px-2 py-0.5 text-xs font-bold"
            >
              <option value="all">Todos</option>
              <option value={1}>1 (Obra)</option>
              <option value={2}>2 (Macro)</option>
              <option value={3}>3 (Etapa)</option>
              <option value={4}>4 (Sub-etapa)</option>
              <option value={5}>5 (Serviço)</option>
            </select>
          </div>
        </div>
      </div>

      {/* 3. CONTEÚDO PRINCIPAL: 2 COLUNAS LADO A LADO */}
      <div className="flex-1 grid grid-cols-12 gap-0 overflow-hidden">
        {/* COLUNA ESQUERDA (7/12): TABELA EAP DE ORÇAMENTO */}
        <div className="col-span-12 lg:col-span-7 border-r border-slate-200 flex flex-col bg-white overflow-hidden">
          <div className="p-3 border-b border-slate-200 bg-slate-50/70 flex items-center justify-between gap-2">
            <div className="font-black text-xs uppercase tracking-wider text-slate-700 flex items-center gap-2">
              <span>📋</span> EAP do Orçamento Executivo
            </div>
            <div className="relative w-64">
              <input
                type="text"
                placeholder="Buscar código EAP ou descrição..."
                value={budgetSearch}
                onChange={(e) => setBudgetSearch(e.target.value)}
                className="w-full bg-white border border-slate-300 rounded-lg pl-7 pr-3 py-1 text-xs focus:outline-hidden focus:border-indigo-500"
              />
              <span className="absolute left-2 top-1.5 text-slate-400 text-xs">🔍</span>
            </div>
          </div>

          <div className="flex-1 overflow-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead className="bg-slate-100 text-slate-600 font-bold sticky top-0 border-b border-slate-200 z-10">
                <tr>
                  <th className="py-2.5 px-3 w-10 text-center">
                    <input
                      type="checkbox"
                      checked={
                        filteredBudgetItems.filter((i) => i.isLeaf).length > 0 &&
                        filteredBudgetItems
                          .filter((i) => i.isLeaf)
                          .every((i) => selectedBudgetItemIds.includes(i.id))
                      }
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedBudgetItemIds(filteredBudgetItems.filter((i) => i.isLeaf).map((i) => i.id));
                        } else {
                          setSelectedBudgetItemIds([]);
                        }
                      }}
                      className="rounded text-indigo-600 focus:ring-0"
                    />
                  </th>
                  <th className="py-2.5 px-3 w-32">EAP</th>
                  <th className="py-2.5 px-3">Descrição do Serviço</th>
                  <th className="py-2.5 px-3 text-right w-36">Total (R$)</th>
                  <th className="py-2.5 px-3 text-center w-28">Vínculo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-mono">
                {filteredBudgetItems.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-400 font-sans italic">
                      Nenhum item de orçamento encontrado com os filtros selecionados.
                    </td>
                  </tr>
                ) : (
                  filteredBudgetItems.map((item) => {
                    const isSelected = selectedBudgetItemIds.includes(item.id);
                    const linkedCount = (item.linkedScheduleIds || []).length;
                    const weights = Object.values(item.weights || {});
                    const sumWeights = weights.reduce((acc, w) => acc + (w || 0), 0);
                    const is100 = linkedCount > 0 && Math.abs(100 - sumWeights) <= 0.05;

                    return (
                      <tr
                        key={item.id}
                        onClick={() => {
                          if (!item.isLeaf) return;
                          setSelectedBudgetItemIds((prev) =>
                            prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id]
                          );
                        }}
                        className={`hover:bg-indigo-50/40 cursor-pointer transition select-none ${
                          isSelected ? 'bg-indigo-50/80' : item.level === 1 ? 'bg-slate-50 font-black' : ''
                        }`}
                      >
                        <td className="py-2 px-3 text-center" onClick={(e) => e.stopPropagation()}>
                          {item.isLeaf && (
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={(e) => {
                                setSelectedBudgetItemIds((prev) =>
                                  e.target.checked ? [...prev, item.id] : prev.filter((id) => id !== item.id)
                                );
                              }}
                              className="rounded text-indigo-600 focus:ring-0"
                            />
                          )}
                        </td>
                        <td className="py-2 px-3 font-mono font-bold text-slate-700 whitespace-nowrap">
                          <span style={{ marginLeft: `${(item.level - 1) * 12}px` }}>
                            {item.level > 1 && <span className="text-slate-400 mr-1">↳</span>}
                            {item.eapCode}
                          </span>
                        </td>
                        <td className="py-2 px-3 font-sans text-slate-800 font-medium">
                          <div className="font-semibold text-slate-900">{item.name}</div>
                          {((item.materialCost !== undefined && item.materialCost > 0) ||
                            (item.laborCost !== undefined && item.laborCost > 0)) && (
                            <div className="text-[10px] text-slate-400 font-mono mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              {item.materialCost !== undefined && item.materialCost > 0 && (
                                <span>Mat: R$ {item.materialCost.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                              )}
                              {item.laborCost !== undefined && item.laborCost > 0 && (
                                <span>MO: R$ {item.laborCost.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right font-mono font-bold text-slate-900 whitespace-nowrap">
                          R$ {item.totalCost.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="py-2 px-3 text-center whitespace-nowrap">
                          {linkedCount === 0 ? (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-sans font-bold bg-slate-100 text-slate-400">
                              Não vinculado
                            </span>
                          ) : is100 ? (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-sans font-bold bg-emerald-100 text-emerald-800 flex items-center justify-center gap-1">
                              <span>🔗</span> 100% ({linkedCount})
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-sans font-bold bg-amber-100 text-amber-800 flex items-center justify-center gap-1">
                              <span>⚠️</span> {sumWeights.toFixed(0)}%
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* COLUNA DIREITA (5/12): PACOTES E ATIVIDADES DO CRONOGRAMA */}
        <div className="col-span-12 lg:col-span-5 flex flex-col bg-slate-50 overflow-hidden">
          <div className="p-3 border-b border-slate-200 bg-white flex items-center justify-between gap-2">
            <div className="font-black text-xs uppercase tracking-wider text-slate-700 flex items-center gap-2">
              <span>📅</span> Pacotes de Trabalho & Tarefas
            </div>
            <div className="relative w-48">
              <input
                type="text"
                placeholder="Buscar no cronograma..."
                value={scheduleSearch}
                onChange={(e) => setScheduleSearch(e.target.value)}
                className="w-full bg-white border border-slate-300 rounded-lg pl-7 pr-3 py-1 text-xs focus:outline-hidden focus:border-indigo-500"
              />
              <span className="absolute left-2 top-1.5 text-slate-400 text-xs">🔍</span>
            </div>
          </div>

          <div className="flex-1 overflow-auto p-3 space-y-2.5">
            {filteredSchedulePackages.map((pkg) => {
              const isExpanded = !!expandedPackages[pkg.service.id];
              const pkgSelectionId = `pkg_${pkg.service.id}`;
              const isPkgSelected = selectedScheduleIds.includes(pkgSelectionId);

              return (
                <div
                  key={pkg.service.id}
                  className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden transition"
                >
                  {/* Cabeçalho do Pacote */}
                  <div
                    className={`p-3 flex items-center justify-between gap-3 cursor-pointer select-none transition ${
                      isPkgSelected ? 'bg-indigo-50/60' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <input
                        type="checkbox"
                        checked={isPkgSelected}
                        onChange={(e) => {
                          e.stopPropagation();
                          setSelectedScheduleIds((prev) =>
                            e.target.checked
                              ? [...prev, pkgSelectionId]
                              : prev.filter((id) => id !== pkgSelectionId)
                          );
                        }}
                        className="rounded text-indigo-600 focus:ring-0"
                      />
                      <span
                        className="w-3.5 h-3.5 rounded-full shrink-0 shadow-xs"
                        style={{ backgroundColor: pkg.service.color || '#6366F1' }}
                      />
                      <div className="truncate">
                        <div className="font-black text-slate-900 text-xs truncate">
                          {pkg.service.name}
                        </div>
                        <div className="text-[10px] text-slate-400 font-mono">
                          {pkg.activities.length} atividades no cronograma
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {pkg.isLinked && (
                        <span className="px-1.5 py-0.5 rounded-full text-[9px] font-black bg-emerald-100 text-emerald-800">
                          🔗 Vinculado
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedPackages((prev) => ({
                            ...prev,
                            [pkg.service.id]: !prev[pkg.service.id],
                          }))
                        }
                        className="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-slate-800 hover:bg-slate-100 text-xs"
                      >
                        {isExpanded ? '▲' : '▼'}
                      </button>
                    </div>
                  </div>

                  {/* Atividades detalhadas nos pavimentos */}
                  {isExpanded && (
                    <div className="border-t border-slate-100 bg-slate-50/50 p-2 space-y-1">
                      {pkg.activities.map((act) => {
                        const flr = floorById.get(act.floorId);
                        const isActSelected = selectedScheduleIds.includes(act.id);
                        const isActLinked = budgetState.items.some((b) =>
                          (b.linkedScheduleIds || []).includes(act.id)
                        );

                        return (
                          <div
                            key={act.id}
                            onClick={() => {
                              setSelectedScheduleIds((prev) =>
                                prev.includes(act.id)
                                  ? prev.filter((id) => id !== act.id)
                                  : [...prev, act.id]
                              );
                            }}
                            className={`p-2 rounded-lg flex items-center justify-between text-xs cursor-pointer transition ${
                              isActSelected ? 'bg-indigo-100/70' : 'hover:bg-white'
                            }`}
                          >
                            <div className="flex items-center gap-2 truncate">
                              <input
                                type="checkbox"
                                checked={isActSelected}
                                onChange={(e) => {
                                  e.stopPropagation();
                                  setSelectedScheduleIds((prev) =>
                                    e.target.checked
                                      ? [...prev, act.id]
                                      : prev.filter((id) => id !== act.id)
                                  );
                                }}
                                className="rounded text-indigo-600 focus:ring-0"
                              />
                              <span className="font-bold text-slate-800 truncate">
                                {flr?.name || 'Pavimento'}
                              </span>
                            </div>
                            <div className="flex items-center gap-3 font-mono text-[11px] text-slate-500 shrink-0">
                              <span>{act.duration}d</span>
                              <span>{flr?.area || 0}m²</span>
                              <span className="font-bold text-slate-700">
                                R$ {Number(act.cost || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0 })}
                              </span>
                              {isActLinked && <span className="text-emerald-600">🔗</span>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 4. MODAL DE PONDERAÇÃO DE PESOS E CUSTOS (PONDERAR) */}
      {isPonderationOpen && (
        <WeightPonderationModal
          budgetState={budgetState}
          activeTab={activePonderationTab}
          setActiveTab={setActivePonderationTab}
          onClose={() => setIsPonderationOpen(false)}
          onSaveItemWeights={(budgetItemId, newWeights, newQuantities) => {
            setBudgetState((prev) => {
              const next = {
                ...prev,
                items: prev.items.map((it) =>
                  it.id === budgetItemId ? { ...it, weights: newWeights, quantities: newQuantities } : it
                ),
                lastUpdated: new Date().toISOString(),
              };
              try {
                cloudStorage.setItem(`curtoprazo_budget_${projectId}`, JSON.stringify(next));
              } catch (_) {}
              return next;
            });
          }}
          onUnlinkActivity={(budgetItemId, actId) => {
            setBudgetState((prev) => {
              const next = {
                ...prev,
                items: prev.items.map((it) => {
                  if (it.id !== budgetItemId) return it;
                  const filtered = (it.linkedScheduleIds || []).filter((id) => id !== actId);
                  const newWeights = { ...it.weights };
                  delete newWeights[actId];
                  return {
                    ...it,
                    linkedScheduleIds: filtered,
                    weights: newWeights,
                  };
                }),
                lastUpdated: new Date().toISOString(),
              };
              try {
                cloudStorage.setItem(`curtoprazo_budget_${projectId}`, JSON.stringify(next));
              } catch (_) {}
              return next;
            });
          }}
          activities={activities}
          floors={localFloors}
          services={services}
        />
      )}

      {/* 5. MODAL DE CONFIGURAÇÃO DE ÁREAS DOS PAVIMENTOS / LOTES */}
      {isAreasModalOpen && (
        <FloorAreasModal
          floors={localFloors}
          replicationGroups={replicationGroups}
          onClose={() => setIsAreasModalOpen(false)}
          onSaveFloors={(updated) => {
            setLocalFloors(updated);
            setIsAreasModalOpen(false);
          }}
        />
      )}

      {/* 6. MODAL DE IMPORTAÇÃO DE ORÇAMENTO */}
      {isImportBudgetOpen && (
        <BudgetImportModal
          projectId={projectId}
          onClose={() => setIsImportBudgetOpen(false)}
          onImportParsedItems={(items) => {
            const next: ProjectBudgetState = {
              projectId,
              budgetName: 'Orçamento Executivo Importado',
              totalCost: items[0]?.level === 1 ? items[0].totalCost : items
                .filter((i) => i.isLeaf)
                .reduce((acc, i) => acc + (i.totalCost || 0), 0),
              items,
              lastUpdated: new Date().toISOString(),
            };
            setBudgetState(next);
            try {
              cloudStorage.setItem(`curtoprazo_budget_${projectId}`, JSON.stringify(next));
            } catch (_) {}
            setIsImportBudgetOpen(false);
          }}
        />
      )}

      {/* 7. MODAL DE IMPORTAÇÃO DE VÍNCULOS */}
      {isImportLinksOpen && (
        <LinksImportModal
          currentBudget={budgetState}
          activities={activities}
          floors={localFloors}
          services={services}
          onClose={() => setIsImportLinksOpen(false)}
          onApplyLinks={(updatedBudget) => {
            setBudgetState(updatedBudget);
            try {
              cloudStorage.setItem(`curtoprazo_budget_${projectId}`, JSON.stringify(updatedBudget));
            } catch (_) {}
            setIsImportLinksOpen(false);
          }}
        />
      )}
    </div>
  );
};

// -------------------------------------------------------------
// SUB-COMPONENTE: MODAL DE PONDERAÇÃO (PESOS E CUSTOS)
// -------------------------------------------------------------
interface WeightPonderationModalProps {
  budgetState: ProjectBudgetState;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  onClose: () => void;
  onSaveItemWeights: (
    budgetItemId: string,
    weights: Record<string, number>,
    quantities?: Record<string, number>
  ) => void;
  onUnlinkActivity: (budgetItemId: string, actId: string) => void;
  activities: LobActivity[];
  floors: ScheduleFloor[];
  services: ScheduleServicePackage[];
}

const WeightPonderationModal: React.FC<WeightPonderationModalProps> = ({
  budgetState,
  activeTab,
  setActiveTab,
  onClose,
  onSaveItemWeights,
  onUnlinkActivity,
  activities,
  floors,
  services,
}) => {
  const floorById = useMemo(() => new Map(floors.map((f) => [f.id, f])), [floors]);
  const serviceById = useMemo(() => new Map(services.map((s) => [s.id, s])), [services]);
  const activityById = useMemo(() => new Map(activities.map((a) => [a.id, a])), [activities]);

  const linkedBudgetItems = useMemo(
    () => budgetState.items.filter((i) => i.isLeaf && (i.linkedScheduleIds || []).length > 0),
    [budgetState.items]
  );

  const currentItem = useMemo(
    () => budgetState.items.find((i) => i.id === activeTab) || linkedBudgetItems[0],
    [budgetState.items, activeTab, linkedBudgetItems]
  );

  // Estado local dos pesos e quantidades editáveis na aba atual
  const [localWeights, setLocalWeights] = useState<Record<string, number>>(() => ({
    ...(currentItem?.weights || {}),
  }));
  const [localQuantities, setLocalQuantities] = useState<Record<string, number>>(() => ({
    ...(currentItem?.quantities || {}),
  }));
  const [activeMode, setActiveMode] = useState<PonderationMode>('equal');

  // Atualiza estado local quando muda a aba
  React.useEffect(() => {
    if (currentItem) {
      setLocalWeights({ ...(currentItem.weights || {}) });
      setLocalQuantities({ ...(currentItem.quantities || {}) });
    }
  }, [currentItem?.id]);

  if (!currentItem) {
    return (
      <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
        <div className="bg-white rounded-2xl p-6 max-w-md w-full text-center space-y-4">
          <p className="text-slate-600 font-bold">Nenhum item de orçamento vinculado para ponderar.</p>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 text-white font-bold rounded-xl text-xs uppercase"
          >
            Fechar
          </button>
        </div>
      </div>
    );
  }

  const linkedActs = (currentItem.linkedScheduleIds || [])
    .map((id) => activityById.get(id))
    .filter(Boolean) as LobActivity[];

  // 1. Aplica Distribuição Igualitária (=)
  const handleApplyEqual = () => {
    setActiveMode('equal');
    const pcts = distributeWeightsEqually(linkedActs.length);
    const nextWeights: Record<string, number> = {};
    linkedActs.forEach((act, idx) => {
      nextWeights[act.id] = pcts[idx];
    });
    setLocalWeights(nextWeights);
  };

  // 2. Aplica Ponderação por Tempo (Duração)
  const handleApplyTime = () => {
    setActiveMode('time');
    const durations = linkedActs.map((act) => Math.max(1, act.duration || 1));
    const pcts = distributeWeightsByTime(durations);
    const nextWeights: Record<string, number> = {};
    linkedActs.forEach((act, idx) => {
      nextWeights[act.id] = pcts[idx];
    });
    setLocalWeights(nextWeights);
  };

  // 3. Aplica Ponderação por Quantidade Física
  const handleApplyQuantity = () => {
    setActiveMode('quantity');
    const qtys = linkedActs.map((act) => localQuantities[act.id] || 1);
    const pcts = distributeWeightsByQuantity(qtys);
    const nextWeights: Record<string, number> = {};
    linkedActs.forEach((act, idx) => {
      nextWeights[act.id] = pcts[idx];
    });
    setLocalWeights(nextWeights);
  };

  // 4. Aplica Ponderação por Área (m²)
  const handleApplyArea = () => {
    setActiveMode('area');
    const areas = linkedActs.map((act) => {
      const flr = floorById.get(act.floorId);
      return Math.max(1, flr?.area || 100);
    });
    const pcts = distributeWeightsByArea(areas);
    const nextWeights: Record<string, number> = {};
    linkedActs.forEach((act, idx) => {
      nextWeights[act.id] = pcts[idx];
    });
    setLocalWeights(nextWeights);
  };

  // Validação da soma
  const weightValues = linkedActs.map((act) => localWeights[act.id] || 0);
  const validation = validateWeightsSum(weightValues);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4 animate-in fade-in">
      <div className="bg-white rounded-2xl shadow-2xl max-w-6xl w-full max-h-[90vh] flex flex-col overflow-hidden border border-slate-200">
        {/* CABEÇALHO DO MODAL */}
        <div className="p-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">⚖️</span>
            <div>
              <h2 className="text-base font-black text-slate-900 tracking-tight">
                Ponderação de Pesos e Custos do Orçamento
              </h2>
              <p className="text-xs text-slate-500">
                Selecione um modo automático ou ajuste manualmente os percentuais das tarefas vinculadas.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-800 hover:bg-slate-200 transition font-black"
          >
            ✕
          </button>
        </div>

        {/* ABAS POR ITEM ORÇAMENTÁRIO SELECIONADO */}
        <div className="flex items-center gap-2 px-6 pt-3 border-b border-slate-200 bg-slate-100 overflow-x-auto">
          {linkedBudgetItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              className={`px-4 py-2 font-mono text-xs font-black rounded-t-xl transition border-t border-x ${
                item.id === currentItem.id
                  ? 'bg-white text-indigo-700 border-slate-200 border-b-white -mb-px'
                  : 'text-slate-500 border-transparent hover:text-slate-800'
              }`}
            >
              {item.eapCode}
            </button>
          ))}
        </div>

        {/* RESUMO DO ITEM ATUAL */}
        <div className="p-5 border-b border-slate-100 bg-white grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
            <div className="text-[10px] font-black uppercase text-slate-400">Código EAP</div>
            <div className="font-mono font-bold text-slate-800 text-sm">{currentItem.eapCode}</div>
          </div>
          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 truncate">
            <div className="text-[10px] font-black uppercase text-slate-400">Descrição</div>
            <div className="font-bold text-slate-800 text-sm truncate">{currentItem.name}</div>
          </div>
          <div className="p-3 bg-slate-50 rounded-xl border border-slate-200">
            <div className="text-[10px] font-black uppercase text-slate-400">Total do Item (R$)</div>
            <div className="font-mono font-black text-indigo-700 text-sm">
              R$ {currentItem.totalCost.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
            </div>
          </div>
        </div>

        {/* SELEÇÃO DOS 4 MODOS DE PONDERAÇÃO */}
        <div className="px-5 py-3 bg-slate-50/80 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-black uppercase text-slate-600">Modo de Distribuição:</span>
            <div className="flex items-center gap-1.5 bg-white p-1 rounded-xl border border-slate-200 shadow-xs">
              <button
                type="button"
                onClick={handleApplyEqual}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1 ${
                  activeMode === 'equal'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
                title="Distribuição uniforme e equilibrada entre todas as atividades"
              >
                <span>=</span> Distribuir Igual
              </button>
              <button
                type="button"
                onClick={handleApplyTime}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1 ${
                  activeMode === 'time'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
                title="Pondera proporcionalmente à duração em dias das atividades"
              >
                <span>⏱️</span> Por Tempo (Duração)
              </button>
              <button
                type="button"
                onClick={handleApplyQuantity}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1 ${
                  activeMode === 'quantity'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
                title="Pondera proporcionalmente às quantidades físicas informadas"
              >
                <span>🔢</span> Por Quantidade
              </button>
              <button
                type="button"
                onClick={handleApplyArea}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1 ${
                  activeMode === 'area'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
                title="Pondera proporcionalmente à área em m² de cada pavimento/local"
              >
                <span>📐</span> Por Área (m²)
              </button>
            </div>
          </div>

          {/* Validação da Soma */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-500">Soma dos Pesos:</span>
            {validation.isValid ? (
              <span className="px-2.5 py-1 rounded-xl font-mono font-black text-xs bg-emerald-100 text-emerald-800 flex items-center gap-1">
                <span>✅</span> 100.00%
              </span>
            ) : (
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 rounded-xl font-mono font-black text-xs bg-amber-100 text-amber-800 flex items-center gap-1">
                  <span>⚠️</span> {validation.sum.toFixed(2)}% (Faltam {validation.delta.toFixed(2)}%)
                </span>
                <button
                  type="button"
                  onClick={() => {
                    // Ajusta a diferença no último item
                    if (linkedActs.length > 0) {
                      const lastId = linkedActs[linkedActs.length - 1].id;
                      setLocalWeights((prev) => ({
                        ...prev,
                        [lastId]: parseFloat(((prev[lastId] || 0) + validation.delta).toFixed(4)),
                      }));
                    }
                  }}
                  className="px-2 py-1 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-[10px] rounded-lg transition"
                >
                  Ajustar Diferença
                </button>
              </div>
            )}
          </div>
        </div>

        {/* TABELA DE ATIVIDADES VINCULADAS */}
        <div className="flex-1 overflow-auto p-5">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-100 text-slate-600 font-bold sticky top-0 border-b border-slate-200">
              <tr>
                <th className="py-2.5 px-3">Atividade / Local</th>
                <th className="py-2.5 px-3 text-center w-24">Duração</th>
                <th className="py-2.5 px-3 text-center w-28">Área Local</th>
                {activeMode === 'quantity' && (
                  <th className="py-2.5 px-3 text-center w-32">Qtd Física</th>
                )}
                <th className="py-2.5 px-3 text-center w-36">Peso (%)</th>
                <th className="py-2.5 px-3 text-right w-40">Custo Atribuído (R$)</th>
                <th className="py-2.5 px-3 text-center w-16">Ação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono">
              {linkedActs.map((act) => {
                const flr = floorById.get(act.floorId);
                const svc = serviceById.get(act.serviceId);
                const weightPct = localWeights[act.id] || 0;
                const costCalc = (weightPct / 100) * currentItem.totalCost;

                return (
                  <tr key={act.id} className="hover:bg-slate-50 transition">
                    <td className="py-2 px-3 font-sans">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: svc?.color || '#6366F1' }}
                        />
                        <span className="font-bold text-slate-800">{flr?.name || 'Pavimento'}</span>
                        <span className="text-slate-400">·</span>
                        <span className="text-slate-600 font-medium">{svc?.name}</span>
                      </div>
                    </td>
                    <td className="py-2 px-3 text-center font-bold text-slate-700">
                      {act.duration} dias
                    </td>
                    <td className="py-2 px-3 text-center font-bold text-slate-700">
                      {flr?.area || 0} m²
                    </td>
                    {activeMode === 'quantity' && (
                      <td className="py-2 px-3 text-center">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={localQuantities[act.id] || ''}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value) || 0;
                            const nextQ = { ...localQuantities, [act.id]: val };
                            setLocalQuantities(nextQ);
                            // Recalcula pesos se estiver no modo por quantidade
                            const qtys = linkedActs.map((a) => (a.id === act.id ? val : nextQ[a.id] || 0));
                            const pcts = distributeWeightsByQuantity(qtys);
                            const nextW: Record<string, number> = {};
                            linkedActs.forEach((a, idx) => {
                              nextW[a.id] = pcts[idx];
                            });
                            setLocalWeights(nextW);
                          }}
                          placeholder="Qtd..."
                          className="w-24 text-center bg-white border border-slate-300 rounded px-2 py-1 text-xs font-mono font-bold"
                        />
                      </td>
                    )}
                    <td className="py-2 px-3 text-center">
                      <div className="inline-flex items-center gap-1">
                        <input
                          type="number"
                          step="0.0001"
                          min="0"
                          max="100"
                          value={weightPct}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value) || 0;
                            setLocalWeights((prev) => ({ ...prev, [act.id]: val }));
                          }}
                          className="w-24 text-center bg-white border border-slate-300 rounded px-2 py-1 text-xs font-mono font-bold text-indigo-700 focus:border-indigo-600 focus:outline-hidden"
                        />
                        <span className="text-slate-400 font-bold">%</span>
                      </div>
                    </td>
                    <td className="py-2 px-3 text-right font-black text-slate-900">
                      R$ {costCalc.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="py-2 px-3 text-center">
                      <button
                        type="button"
                        onClick={() => onUnlinkActivity(currentItem.id, act.id)}
                        className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition"
                        title="Desvincular esta atividade"
                      >
                        🗑️
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* RODAPÉ DO MODAL */}
        <div className="p-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between">
          <div className="text-xs text-slate-500 font-medium">
            {linkedActs.length} tarefas vinculadas a este item de orçamento.
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-xs rounded-xl transition"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => {
                onSaveItemWeights(currentItem.id, localWeights, localQuantities);
                onClose();
              }}
              className="px-5 py-2 bg-emerald-700 hover:bg-emerald-800 text-white font-black text-xs uppercase tracking-wider rounded-xl transition shadow-sm"
            >
              Salvar Ponderação
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// -------------------------------------------------------------
// SUB-COMPONENTE: MODAL DE CONFIGURAÇÃO DE ÁREAS DOS PAVIMENTOS
// -------------------------------------------------------------
interface FloorAreasModalProps {
  floors: ScheduleFloor[];
  replicationGroups: ReplicationGroup[];
  onClose: () => void;
  onSaveFloors: (updated: ScheduleFloor[]) => void;
}

const FloorAreasModal: React.FC<FloorAreasModalProps> = ({
  floors,
  replicationGroups,
  onClose,
  onSaveFloors,
}) => {
  const [localFloors, setLocalFloors] = useState<ScheduleFloor[]>([...floors]);

  const totalArea = useMemo(
    () => localFloors.reduce((acc, f) => acc + (f.area || 0), 0),
    [localFloors]
  );

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full max-h-[85vh] flex flex-col overflow-hidden border border-slate-200">
        <div className="p-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="text-2xl">📐</span>
            <div>
              <h3 className="text-base font-black text-slate-900">
                Configuração de Áreas dos Locais e Lotes
              </h3>
              <p className="text-xs text-slate-500">
                Preencha a área de cada pavimento em m² para servir de base na ponderação orçamentária.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-800 hover:bg-slate-200 transition font-black"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-3 bg-indigo-50/70 border-b border-indigo-100 flex items-center justify-between text-xs">
          <span className="font-bold text-indigo-950">Área Total da Obra:</span>
          <span className="font-mono font-black text-indigo-700 text-sm">
            {totalArea.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} m²
          </span>
        </div>

        <div className="flex-1 overflow-auto p-5">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-100 text-slate-600 font-bold sticky top-0 border-b border-slate-200">
              <tr>
                <th className="py-2 px-3">Pavimento / Local</th>
                <th className="py-2 px-3">Agrupamento / Lote</th>
                <th className="py-2 px-3 text-center w-36">Área (m²)</th>
                <th className="py-2 px-3 text-right w-28">% Relativo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono">
              {localFloors.map((flr) => {
                const grp = replicationGroups.find((g) => g.id === flr.replicationGroupId);
                const pct = totalArea > 0 ? ((flr.area || 0) / totalArea) * 100 : 0;

                return (
                  <tr key={flr.id} className="hover:bg-slate-50 transition">
                    <td className="py-2 px-3 font-sans font-bold text-slate-800">
                      {flr.name}
                    </td>
                    <td className="py-2 px-3 font-sans text-slate-500">
                      {grp?.name || 'Não agrupado'}
                    </td>
                    <td className="py-2 px-3 text-center">
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={flr.area || ''}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value) || 0;
                          setLocalFloors((prev) =>
                            prev.map((f) => (f.id === flr.id ? { ...f, area: val } : f))
                          );
                        }}
                        className="w-28 text-center bg-white border border-slate-300 rounded px-2 py-1 font-mono font-bold text-slate-800 focus:border-indigo-600 focus:outline-hidden"
                      />
                    </td>
                    <td className="py-2 px-3 text-right font-bold text-slate-700">
                      {pct.toFixed(2)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="p-4 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-xs rounded-xl transition"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => onSaveFloors(localFloors)}
            className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs uppercase tracking-wider rounded-xl transition shadow-sm"
          >
            Salvar Áreas
          </button>
        </div>
      </div>
    </div>
  );
};

// -------------------------------------------------------------
// SUB-COMPONENTE: MODAL DE IMPORTAÇÃO DE PLANILHA DE ORÇAMENTO
// -------------------------------------------------------------
interface BudgetImportModalProps {
  projectId: string;
  onClose: () => void;
  onImportParsedItems: (items: BudgetItem[]) => void;
}

const BudgetImportModal: React.FC<BudgetImportModalProps> = ({
  projectId,
  onClose,
  onImportParsedItems,
}) => {
  const [fileName, setFileName] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [previewItems, setPreviewItems] = useState<BudgetItem[] | null>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setIsProcessing(true);
    setErrorMsg('');
    setPreviewItems(null);

    try {
      const XLSX = await import('xlsx');
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[firstSheetName];
      const rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1 });

      const parsed = parseBudgetRows(rows, projectId);
      if (parsed.length === 0) {
        setErrorMsg('Nenhum item com Código/EAP ou Descrição válido encontrado na planilha.');
        setIsProcessing(false);
        return;
      }
      setPreviewItems(parsed);
    } catch (err: any) {
      setErrorMsg(`Erro ao ler planilha: ${err?.message || 'Arquivo inválido'}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const grandTotal = useMemo(() => {
    if (!previewItems) return 0;
    const root = previewItems.find((i) => i.level === 1);
    if (root && root.totalCost > 0) return root.totalCost;
    return previewItems.filter((i) => i.isLeaf).reduce((acc, i) => acc + (i.totalCost || 0), 0);
  }, [previewItems]);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full p-6 space-y-4 border border-slate-200">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl">📥</span>
            <div>
              <h3 className="text-base font-black text-slate-900">Importar Orçamento Executivo</h3>
              <p className="text-xs text-slate-500">Envie a planilha analítica ou EAP de custos da obra.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-800 hover:bg-slate-200 transition font-black"
          >
            ✕
          </button>
        </div>

        {/* 1. SEÇÃO DE DOWNLOAD DO MODELO */}
        <div className="bg-emerald-50/70 border border-emerald-200 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="font-black text-xs text-emerald-950 flex items-center gap-1.5">
              <span>📋</span> Planilha Modelo de Orçamento
            </div>
            <div className="text-[11px] text-emerald-800">
              Colunas: <span className="font-mono font-bold">Nível, Código, Descrição, Material (R$), Mão de Obra (R$), Total (R$)</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <a
              href="/templates/modelo_orcamento.xlsx"
              download="modelo_orcamento.xlsx"
              className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-lg transition shadow-xs flex items-center gap-1.5"
            >
              <span>📥</span> Baixar Modelo (.xlsx)
            </a>
            <a
              href="/templates/modelo_orcamento.csv"
              download="modelo_orcamento.csv"
              className="px-2.5 py-1.5 bg-white hover:bg-slate-100 text-slate-700 border border-emerald-300 font-bold text-xs rounded-lg transition shadow-xs"
              title="Baixar modelo em CSV"
            >
              .csv
            </a>
          </div>
        </div>

        {/* 2. ÁREA DE UPLOAD */}
        <label className="border-2 border-dashed border-slate-300 hover:border-emerald-500 rounded-xl p-6 flex flex-col items-center justify-center gap-2 cursor-pointer transition bg-slate-50 hover:bg-emerald-50/20">
          <span className="text-3xl">📄</span>
          <span className="text-xs font-bold text-slate-700 text-center">
            {fileName || 'Clique ou arraste para escolher a planilha preenchida'}
          </span>
          <span className="text-[10px] text-slate-400">Formatos aceitos: Excel (.xlsx, .xls) ou CSV (.csv)</span>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleFileUpload}
            className="hidden"
          />
        </label>

        {isProcessing && (
          <div className="text-center text-xs font-bold text-emerald-700 animate-pulse">
            Processando linhas e estruturando EAP...
          </div>
        )}

        {errorMsg && (
          <div className="p-3 bg-red-50 rounded-xl text-red-700 text-xs font-bold border border-red-200">
            {errorMsg}
          </div>
        )}

        {/* 3. RESUMO DO PREVIEW */}
        {previewItems && (
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-1.5 text-xs font-mono">
            <div className="flex justify-between text-slate-700 font-bold">
              <span>Itens Identificados:</span>
              <span>{previewItems.length} linhas</span>
            </div>
            <div className="flex justify-between text-slate-700 font-bold">
              <span>Itens Folha (Serviços):</span>
              <span>{previewItems.filter((i) => i.isLeaf).length} itens</span>
            </div>
            <div className="flex justify-between text-emerald-800 font-black border-t border-slate-200 pt-1.5 text-sm">
              <span>Custo Total Orçado:</span>
              <span>R$ {grandTotal.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-xs rounded-xl transition"
          >
            Cancelar
          </button>
          {previewItems && (
            <button
              type="button"
              onClick={() => onImportParsedItems(previewItems)}
              className="px-5 py-2 bg-emerald-700 hover:bg-emerald-800 text-white font-black text-xs uppercase tracking-wider rounded-xl transition shadow-md active:scale-95"
            >
              Aplicar Orçamento
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

// -------------------------------------------------------------
// SUB-COMPONENTE: MODAL DE IMPORTAÇÃO DE PLANILHA DE VÍNCULOS
// -------------------------------------------------------------
interface LinksImportModalProps {
  currentBudget: ProjectBudgetState;
  activities: LobActivity[];
  floors: ScheduleFloor[];
  services: ScheduleServicePackage[];
  onClose: () => void;
  onApplyLinks: (updatedBudget: ProjectBudgetState) => void;
}

const LinksImportModal: React.FC<LinksImportModalProps> = ({
  currentBudget,
  activities,
  floors,
  services,
  onClose,
  onApplyLinks,
}) => {
  const [fileName, setFileName] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [previewResult, setPreviewResult] = useState<{
    updatedBudget: ProjectBudgetState;
    matchedCount: number;
    unmatchedCount: number;
    unmatchedList: { code: string; pkg: string; lot: string; desc: string }[];
  } | null>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setIsProcessing(true);
    setErrorMsg('');
    setPreviewResult(null);

    try {
      const XLSX = await import('xlsx');
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[firstSheetName];
      const rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1 });

      const linkRows = parseBudgetLinkingRows(rows);
      if (linkRows.length === 0) {
        setErrorMsg(
          'Nenhum vínculo válido encontrado. Verifique se o arquivo possui colunas como Código, Pacote de trabalho/tarefas e Lote.'
        );
        setIsProcessing(false);
        return;
      }

      const result = applyImportedLinksToBudget(
        currentBudget,
        linkRows,
        activities,
        floors,
        services
      );
      setPreviewResult(result);
    } catch (err: any) {
      setErrorMsg(`Erro ao ler vínculos: ${err?.message || 'Arquivo inválido'}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const totalProcessed = previewResult
    ? previewResult.matchedCount + previewResult.unmatchedCount
    : 0;
  const matchPercent =
    totalProcessed > 0
      ? Math.round((previewResult!.matchedCount / totalProcessed) * 100)
      : 0;

  const linkedLeavesCount = useMemo(() => {
    if (!previewResult) return 0;
    return previewResult.updatedBudget.items.filter(
      (i) => i.isLeaf && (i.linkedScheduleIds || []).length > 0
    ).length;
  }, [previewResult]);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full p-6 space-y-4 border border-slate-200">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🔗</span>
            <div>
              <h3 className="text-base font-black text-slate-900">Importar Vínculos com o Cronograma</h3>
              <p className="text-xs text-slate-500">Mapeie tarefas e pacotes do cronograma com os itens do orçamento.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-800 hover:bg-slate-200 transition font-black"
          >
            ✕
          </button>
        </div>

        {/* 1. SEÇÃO DE DOWNLOAD DO MODELO */}
        <div className="bg-indigo-50/70 border border-indigo-200 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <div className="font-black text-xs text-indigo-950 flex items-center gap-1.5">
              <span>📋</span> Planilha Modelo de Vínculos
            </div>
            <div className="text-[11px] text-indigo-800">
              Colunas: <span className="font-mono font-bold">Nível, Código, Descrição, Custo, Pacote, Serviço, Lote, Parte, Peso (%)</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <a
              href="/templates/modelo_vinculos.xlsx"
              download="modelo_vinculos.xlsx"
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs rounded-lg transition shadow-xs flex items-center gap-1.5"
            >
              <span>📥</span> Baixar Modelo (.xlsx)
            </a>
            <a
              href="/templates/modelo_vinculos.csv"
              download="modelo_vinculos.csv"
              className="px-2.5 py-1.5 bg-white hover:bg-slate-100 text-slate-700 border border-indigo-300 font-bold text-xs rounded-lg transition shadow-xs"
              title="Baixar modelo em CSV"
            >
              .csv
            </a>
          </div>
        </div>

        {/* 2. ÁREA DE UPLOAD */}
        <label className="border-2 border-dashed border-slate-300 hover:border-indigo-500 rounded-xl p-6 flex flex-col items-center justify-center gap-2 cursor-pointer transition bg-slate-50 hover:bg-indigo-50/20">
          <span className="text-3xl">📑</span>
          <span className="text-xs font-bold text-slate-700 text-center">
            {fileName || 'Clique ou arraste a planilha de vínculos preenchida'}
          </span>
          <span className="text-[10px] text-slate-400">Formatos aceitos: Excel (.xlsx, .xls) ou CSV (.csv)</span>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleFileUpload}
            className="hidden"
          />
        </label>

        {isProcessing && (
          <div className="text-center text-xs font-bold text-indigo-700 animate-pulse">
            Cruzando pacotes, serviços e pavimentos do cronograma...
          </div>
        )}

        {errorMsg && (
          <div className="p-3 bg-red-50 rounded-xl text-red-700 text-xs font-bold border border-red-200">
            {errorMsg}
          </div>
        )}

        {/* 3. RESUMO DO RESULTADO */}
        {previewResult && (
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2 text-xs">
            <div className="flex items-center justify-between font-mono">
              <span className="text-slate-600 font-bold">Vínculos Processados:</span>
              <span className="font-black text-slate-900">{totalProcessed}</span>
            </div>
            <div className="flex items-center justify-between font-mono">
              <span className="text-slate-600 font-bold">Correspondências no Cronograma:</span>
              <span className="font-black text-emerald-700">
                {previewResult.matchedCount} ({matchPercent}%)
              </span>
            </div>
            <div className="flex items-center justify-between font-mono">
              <span className="text-slate-600 font-bold">Itens de Orçamento Vinculados:</span>
              <span className="font-black text-indigo-700">{linkedLeavesCount} itens</span>
            </div>

            {previewResult.unmatchedCount > 0 && (
              <div className="mt-2 pt-2 border-t border-slate-200 text-amber-800 text-[11px] font-sans">
                <span className="font-bold">⚠️ {previewResult.unmatchedCount} registros</span> não encontraram correspondência exata de pacote ou pavimento.
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-xs rounded-xl transition"
          >
            Cancelar
          </button>
          {previewResult && (
            <button
              type="button"
              onClick={() => onApplyLinks(previewResult.updatedBudget)}
              className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs uppercase tracking-wider rounded-xl transition shadow-md active:scale-95"
            >
              Aplicar Vínculos ({previewResult.matchedCount})
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

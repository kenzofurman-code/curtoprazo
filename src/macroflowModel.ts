// Modelo de Dados e Utilitários para o Criador de Macrofluxo (Process Mapping / Swimlanes)
// Suporta exportação/importação Excel, conexões inter-raias e geração de Linha de Balanço
import * as XLSX from 'xlsx';
import type {
  LongTermScheduleState,
  ScheduleServicePackage,
  ScheduleJobTemplate,
  LobActivity,
  LobActivityJob,
  DependencyRule,
  ReplicationGroup,
  ScheduleFloor,
} from './longTermSchedule';
import {
  addWorkingDays,
  slugifySchedule,
} from './longTermSchedule';

export interface MacroflowJob {
  id: string;
  name: string;
  defaultDurationDays: number;
  costWeight?: number;
  responsible?: string;
}

export interface MacroflowPackage {
  id: string;
  name: string;
  color: string;
  rhythmText: string; // Ex: "10d - por pvto", "1d - por pvto", "15d - cada 200 m2"
  rhythmDays: number; // Dias por pavimento/ciclo (padrão derivado)
  position: number;
  colIndex?: number;
  jobs: MacroflowJob[];
  defaultResponsible?: string;
  isMilestone?: boolean;
}

export interface InterSwimlaneLink {
  id: string;
  sourceSwimlaneId: string;
  sourcePackageId: string;
  targetSwimlaneId: string;
  targetPackageId: string;
  type: 'finish_to_start' | 'floor_lag' | 'day_lag';
  lagValue: number; // ex: 5 pavimentos de avanço ou 10 dias
  description?: string;
}

export interface MacroflowSwimlane {
  id: string;
  name: string;
  category: 'milestones' | 'tower' | 'facade' | 'roof' | 'basement' | 'external' | 'general' | 'custom';
  color: string;
  targetGroupName?: string; // Associa a um grupo de pavimentos da Linha de Balanço
  packages: MacroflowPackage[];
}

export interface MacroflowProjectData {
  version: string;
  updatedAt: string;
  swimlanes: MacroflowSwimlane[];
  interLinks: InterSwimlaneLink[];
}

// Extrai número de dias do texto de ritmo (ex: "10d - por pvto" -> 10)
export function parseRhythmDays(text?: string): number {
  if (!text) return 5;
  const match = text.match(/(\d+)\s*d/i) || text.match(/^(\d+)$/);
  if (match && match[1]) {
    const val = parseInt(match[1], 10);
    if (!isNaN(val) && val > 0) return val;
  }
  return 5;
}

export function getDefaultMacroflowModel(): MacroflowProjectData {
  return { version: '1.0', updatedAt: new Date().toISOString(), swimlanes: [], interLinks: [] };
}

// =========================================================================
// EXPORTAÇÃO EXCEL IDÊNTICA AO MODELO DO USUÁRIO
// =========================================================================
export function exportMacroflowToExcel(data: MacroflowProjectData, projectName = 'Obra'): void {
  const wb = XLSX.utils.book_new();

  // Aba 1: Macrofluxo (Visual em tabela com Raias, Ritmos, Pacotes e Tarefas)
  const rows: (string | number)[][] = [];

  // Calcula a maior coluna utilizada
  const maxCol = Math.max(
    36,
    ...data.swimlanes.flatMap((s) => s.packages.map((p) => p.colIndex || 0))
  );

  // Linha 1: Cabeçalho com Marcos em suas colunas reais
  const milestonesSwimlane = data.swimlanes.find((s) => s.category === 'milestones');
  const marcosRow: (string | number)[] = new Array(maxCol + 1).fill('');
  marcosRow[0] = 'MARCOS';
  (milestonesSwimlane?.packages || []).forEach((m, idx) => {
    const col = m.colIndex || (idx + 4);
    marcosRow[col] = m.name;
  });
  rows.push(marcosRow);
  rows.push([]);

  // Para cada raia (exceto marcos, já impressos no topo)
  const contentSwimlanes = data.swimlanes.filter((s) => s.category !== 'milestones');

  contentSwimlanes.forEach((sw) => {
    // Linha de identificação da Raia + Ritmos dos pacotes em suas colunas
    const rhythmRow: (string | number)[] = new Array(maxCol + 1).fill('');
    rhythmRow[0] = sw.name;
    sw.packages.forEach((pkg, idx) => {
      const col = pkg.colIndex || (idx + 3);
      rhythmRow[col] = pkg.rhythmText || `${pkg.rhythmDays}d`;
    });
    rows.push(rhythmRow);

    // Linha com os nomes dos Pacotes de Trabalho em suas colunas
    const pkgRow: (string | number)[] = new Array(maxCol + 1).fill('');
    sw.packages.forEach((pkg, idx) => {
      const col = pkg.colIndex || (idx + 3);
      pkgRow[col] = pkg.name;
    });
    rows.push(pkgRow);

    // Linhas subsequentes com as sub-tarefas (Jobs) alinhadas abaixo de cada pacote
    const maxJobs = Math.max(1, ...sw.packages.map((p) => p.jobs?.length || 0));
    for (let jIdx = 0; jIdx < maxJobs; jIdx++) {
      const jobRow: (string | number)[] = new Array(maxCol + 1).fill('');
      sw.packages.forEach((pkg, idx) => {
        const col = pkg.colIndex || (idx + 3);
        const job = pkg.jobs?.[jIdx];
        jobRow[col] = job ? job.name : '';
      });
      rows.push(jobRow);
    }

    // Linha em branco separadora entre raias
    rows.push([]);
    rows.push([]);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Macrofluxo de Obra');

  // Aba 2: Conexões Inter-Raias (Documentação das Vinculações)
  const linkRows: (string | number)[][] = [
    ['ID Vínculo', 'Raia Origem', 'Pacote Origem', 'Raia Destino', 'Pacote Destino', 'Tipo de Relação', 'Defasagem (Lag)', 'Descrição da Regra'],
  ];

  data.interLinks.forEach((l) => {
    const sSw = data.swimlanes.find((s) => s.id === l.sourceSwimlaneId);
    const sPkg = sSw?.packages.find((p) => p.id === l.sourcePackageId);
    const tSw = data.swimlanes.find((s) => s.id === l.targetSwimlaneId);
    const tPkg = tSw?.packages.find((p) => p.id === l.targetPackageId);

    linkRows.push([
      l.id,
      sSw?.name || l.sourceSwimlaneId,
      sPkg?.name || l.sourcePackageId,
      tSw?.name || l.targetSwimlaneId,
      tPkg?.name || l.targetPackageId,
      l.type === 'floor_lag' ? 'Defasagem de Pavimentos' : l.type === 'day_lag' ? 'Defasagem em Dias' : 'Fim para Início (FS)',
      l.lagValue || 0,
      l.description || '',
    ]);
  });

  const wsLinks = XLSX.utils.aoa_to_sheet(linkRows);
  XLSX.utils.book_append_sheet(wb, wsLinks, 'Vínculos Inter-Raias');

  XLSX.writeFile(wb, `Macrofluxo_Obra_${projectName.replace(/\s+/g, '_')}.xlsx`);
}

// =========================================================================
// PARSER DO EXCEL ENVIADO PELO USUÁRIO (REMONTANDO A ESTRUTURA AUTOMATICAMENTE)
// =========================================================================
export function parseMacroflowFromExcel(fileBuffer: ArrayBuffer | Uint8Array): MacroflowProjectData {
  const wb = XLSX.read(fileBuffer, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rawRows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  const swimlanes: MacroflowSwimlane[] = [];
  const interLinks: InterSwimlaneLink[] = [];

  // Categorias padrão por nome de raia
  const categoryMap: Record<string, MacroflowSwimlane['category']> = {
    marcos: 'milestones',
    'áreas externas': 'external',
    'areas externas': 'external',
    subsolos: 'basement',
    subsolo: 'basement',
    torre: 'tower',
    'torre-pavimentos': 'tower',
    fachada: 'facade',
    fachadas: 'facade',
    ático: 'roof',
    'ático/cobertura': 'roof',
    atico: 'roof',
    geral: 'general',
    'geral e custos': 'general',
  };

  const colorMap: Record<string, string> = {
    milestones: '#6366f1',
    external: '#059669',
    basement: '#475569',
    tower: '#0284c7',
    facade: '#d97706',
    roof: '#e11d48',
    general: '#334155',
    custom: '#64748b',
  };

  let rIdx = 0;
  while (rIdx < rawRows.length) {
    const row = rawRows[rIdx];
    if (!row || row.length === 0) {
      rIdx++;
      continue;
    }

    const firstCell = String(row[0] || '').trim();
    if (!firstCell) {
      rIdx++;
      continue;
    }

    const lowerFirst = firstCell.toLowerCase();

    // Se for linha de Marcos
    if (lowerFirst.includes('marco')) {
      const milestonePackages: MacroflowPackage[] = [];
      for (let c = 1; c < row.length; c++) {
        const val = String(row[c] || '').trim();
        if (val) {
          milestonePackages.push({
            id: `m_${slugifySchedule(val)}_${c}`,
            name: val,
            color: '#4f46e5',
            rhythmText: '0d - marco',
            rhythmDays: 0,
            position: milestonePackages.length + 1,
            colIndex: c,
            isMilestone: true,
            jobs: [],
          });
        }
      }
      if (milestonePackages.length > 0) {
        swimlanes.push({
          id: 'sw_milestones',
          name: firstCell,
          category: 'milestones',
          color: '#6366f1',
          packages: milestonePackages,
        });
      }
      rIdx++;
      continue;
    }

    // Detecta início de uma raia de macrofluxo (ex: Áreas externas, Subsolos, Torre, Fachada...)
    const matchedCategoryKey = Object.keys(categoryMap).find((k) => lowerFirst.includes(k));
    const cat = matchedCategoryKey ? categoryMap[matchedCategoryKey] : 'custom';
    const swimlaneName = firstCell;
    const swimlaneId = `sw_${slugifySchedule(swimlaneName)}_${Date.now().toString(36)}`;

    // A linha atual contém os ritmos das colunas
    // A próxima linha (rIdx + 1) contém os nomes dos pacotes
    const rhythmRow = row;
    const pkgNameRow = rawRows[rIdx + 1] || [];

    // Encontra quais colunas têm pacotes
    const colIndices: number[] = [];
    for (let c = 0; c < Math.max(rhythmRow.length, pkgNameRow.length); c++) {
      const pName = String(pkgNameRow[c] || '').trim();
      const rText = String(rhythmRow[c] || '').trim();
      if (pName && pName !== '0' && c > 0) {
        colIndices.push(c);
      }
    }

    if (colIndices.length > 0) {
      // Coleta tarefas das linhas subsequentes até encontrar linha vazia ou próxima raia
      let jobRowScan = rIdx + 2;
      const jobRows: any[][] = [];
      while (jobRowScan < rawRows.length) {
        const testRow = rawRows[jobRowScan];
        const testFirst = String(testRow?.[0] || '').trim();
        // Se a primeira coluna tem novo nome de raia, encerra esta
        if (testFirst && Object.keys(categoryMap).some((k) => testFirst.toLowerCase().includes(k))) {
          break;
        }
        // Se a linha tem conteúdo nas colunas dos pacotes, guarda
        const hasContent = colIndices.some((c) => String(testRow?.[c] || '').trim() !== '');
        if (hasContent) {
          jobRows.push(testRow);
        } else if (jobRows.length > 0) {
          // Linha em branco após coletar tarefas: pode ser separador
          break;
        }
        jobRowScan++;
      }

      const packages: MacroflowPackage[] = [];
      colIndices.forEach((c, idx) => {
        const pkgName = String(pkgNameRow[c] || '').trim();
        const rhythmText = String(rhythmRow[c] || '').trim();
        const rhythmDays = parseRhythmDays(rhythmText);

        const jobs: MacroflowJob[] = [];
        jobRows.forEach((jRow, jIdx) => {
          const jName = String(jRow[c] || '').trim();
          if (jName && jName !== '0') {
            jobs.push({
              id: `j_${slugifySchedule(pkgName)}_${jIdx + 1}`,
              name: jName,
              defaultDurationDays: Math.max(1, Math.round(rhythmDays / (jobs.length + 1)) || 2),
            });
          }
        });

        packages.push({
          id: `pkg_${slugifySchedule(swimlaneName)}_${slugifySchedule(pkgName)}`,
          name: pkgName,
          color: colorMap[cat] || '#0284c7',
          rhythmText: rhythmText || `${rhythmDays}d`,
          rhythmDays,
          position: idx + 1,
          colIndex: c,
          jobs,
        });
      });

      swimlanes.push({
        id: swimlaneId,
        name: swimlaneName,
        category: cat,
        color: colorMap[cat] || '#0284c7',
        targetGroupName: swimlaneName,
        packages,
      });

      rIdx = jobRowScan;
      continue;
    }

    rIdx++;
  }

  // Tenta ler Aba 2 se existir (Vínculos Inter-Raias)
  if (wb.SheetNames.length > 1) {
    try {
      const linkSheet = wb.Sheets[wb.SheetNames[1]];
      const rawLinks: any[][] = XLSX.utils.sheet_to_json(linkSheet, { header: 1, defval: '' });
      for (let i = 1; i < rawLinks.length; i++) {
        const row = rawLinks[i];
        if (row && row[0]) {
          interLinks.push({
            id: String(row[0]),
            sourceSwimlaneId: String(row[1] || ''),
            sourcePackageId: String(row[2] || ''),
            targetSwimlaneId: String(row[3] || ''),
            targetPackageId: String(row[4] || ''),
            type: String(row[5] || '').includes('Pavimento') ? 'floor_lag' : 'finish_to_start',
            lagValue: Number(row[6]) || 0,
            description: String(row[7] || ''),
          });
        }
      }
    } catch (_) {}
  }

  // Se o arquivo tiver pelo menos 1 raia válida, retorna o resultado
  if (swimlanes.length > 0) {
    return {
      version: '1.0',
      updatedAt: new Date().toISOString(),
      swimlanes,
      interLinks,
    };
  }

  // Arquivo vazio não cria atividades ou vínculos de exemplo.
  return getDefaultMacroflowModel();
}

// =========================================================================
// MOTOR DE LANÇAMENTO: GERAÇÃO DA LINHA DE BALANÇO A PARTIR DO MACROFLUXO
// =========================================================================
export function applyMacroflowToSchedule(
  macroflow: MacroflowProjectData,
  currentState: LongTermScheduleState,
  options?: { defaultStartDate?: string }
): LongTermScheduleState {
  const startDate = options?.defaultStartDate || currentState.calendar.startDate;

  // 1. Cria ou sincroniza os Agrupamentos de Replicação (ReplicationGroups)
  const existingGroups = [...currentState.replicationGroups];
  const groupByName = new Map<string, ReplicationGroup>();
  existingGroups.forEach((g) => groupByName.set(g.name.toLowerCase().trim(), g));

  const contentSwimlanes = macroflow.swimlanes.filter((s) => s.category !== 'milestones');

  contentSwimlanes.forEach((sw, idx) => {
    const key = (sw.targetGroupName || sw.name).toLowerCase().trim();
    if (!groupByName.has(key)) {
      const newGroup: ReplicationGroup = {
        id: `grp_${slugifySchedule(sw.name)}_${Date.now().toString(36)}`,
        name: sw.targetGroupName || sw.name,
        position: existingGroups.length + 1,
        linesPerFloor: 2,
        color: sw.color,
      };
      existingGroups.push(newGroup);
      groupByName.set(key, newGroup);
    }
  });

  // 2. Cria os Pacotes de Serviço (ScheduleServicePackages)
  const services: ScheduleServicePackage[] = [];
  const serviceByPkgId = new Map<string, ScheduleServicePackage>();

  contentSwimlanes.forEach((sw) => {
    const sortedPkgs = [...sw.packages].sort((a, b) => (a.colIndex ?? a.position) - (b.colIndex ?? b.position));
    sortedPkgs.forEach((pkg, pIdx) => {
      const jobs: ScheduleJobTemplate[] = (pkg.jobs || []).map((j, jIdx) => ({
        id: `tpl_${slugifySchedule(pkg.name)}_${jIdx + 1}`,
        name: j.name,
        position: jIdx + 1,
        defaultDuration: j.defaultDurationDays || 2,
        defaultResponsible: 'EQUIPE GERAL',
        costWeight: j.costWeight ?? 0,
      }));

      const sumJobDuration = jobs.reduce((acc, j) => acc + j.defaultDuration, 0);

      const sPkg: ScheduleServicePackage = {
        id: `pkg_${slugifySchedule(pkg.name)}_${pIdx + 1}`,
        name: pkg.name,
        color: pkg.color,
        position: services.length + 1,
        defaultLine: 1,
        defaultDuration: sumJobDuration > 0 ? sumJobDuration : pkg.rhythmDays || 5,
        defaultResponsible: 'EQUIPE GERAL',
        defaultTotalCost: jobs.reduce((total, job) => total + (job.costWeight || 0), 0),
        autoChainJobs: true,
        jobs: jobs.length > 0 ? jobs : [
          {
            id: `tpl_${slugifySchedule(pkg.name)}_1`,
            name: pkg.name,
            position: 1,
            defaultDuration: pkg.rhythmDays || 5,
            defaultResponsible: 'EQUIPE GERAL',
            costWeight: 0,
          },
        ],
      };

      services.push(sPkg);
      serviceByPkgId.set(pkg.id, sPkg);
    });
  });

  // Usa somente os locais cadastrados pelo usuário.
  const floors = [...currentState.floors];

  // 4. Gera as Atividades na Linha de Balanço respeitando:
  //    - Ritmo vertical (escadinha de pavimentos)
  //    - Predecessora horizontal (entre pacotes da mesma raia no mesmo pavimento)
  const activities: LobActivity[] = [];
  let currentBaseDate = startDate;

  contentSwimlanes.forEach((sw) => {
    const grp = groupByName.get((sw.targetGroupName || sw.name).toLowerCase().trim());
    if (!grp) return;

    const grpFloors = floors.filter((f) => f.replicationGroupId === grp.id);
    if (grpFloors.length === 0) return;

    let previousServiceLastFloorEnd = currentBaseDate;
    const sortedPkgs = [...sw.packages].sort((a, b) => (a.colIndex ?? a.position) - (b.colIndex ?? b.position));

    sortedPkgs.forEach((pkg, pIdx) => {
      const sPkg = serviceByPkgId.get(pkg.id);
      if (!sPkg) return;

      const rhythm = Math.max(1, pkg.rhythmDays || sPkg.defaultDuration || 5);
      let floorStartDate = previousServiceLastFloorEnd;

      grpFloors.forEach((flr, fIdx) => {
        const actStart = fIdx === 0 ? floorStartDate : addWorkingDays(floorStartDate, fIdx * rhythm + 1, currentState.calendar);
        const actEnd = addWorkingDays(actStart, sPkg.defaultDuration, currentState.calendar);

        // Predecessoras:
        // Predecessora vertical: mesma atividade no pavimento anterior
        const predIds: string[] = [];
        if (fIdx > 0) {
          const prevFloorAct = activities.find(
            (a) => a.serviceId === sPkg.id && a.floorId === grpFloors[fIdx - 1].id
          );
          if (prevFloorAct) predIds.push(prevFloorAct.id);
        }

        // Predecessora horizontal: pacote anterior no mesmo pavimento
        if (pIdx > 0) {
          const prevPkg = sortedPkgs[pIdx - 1];
          const prevSPkg = serviceByPkgId.get(prevPkg.id);
          if (prevSPkg) {
            const sameFloorPrevAct = activities.find(
              (a) => a.serviceId === prevSPkg.id && a.floorId === flr.id
            );
            if (sameFloorPrevAct && !predIds.includes(sameFloorPrevAct.id)) {
              predIds.push(sameFloorPrevAct.id);
            }
          }
        }

        // Regras paramétricas
        const rules: DependencyRule[] = [];
        if (pIdx > 0) {
          const prevPkg = sortedPkgs[pIdx - 1];
          const prevSPkg = serviceByPkgId.get(prevPkg.id);
          if (prevSPkg) {
            rules.push({
              id: `rule_h_${sPkg.id}_${prevSPkg.id}`,
              precedenceAttribute: 'start',
              delay: 0,
              timeOperation: 'after',
              baseAttribute: 'end',
              predecessorServiceId: prevSPkg.id,
              floorDirection: 'same',
            });
          }
        }

        const actJobs: LobActivityJob[] = sPkg.jobs.map((j) => ({
          id: `job_${slugifySchedule(flr.name)}_${sPkg.id}_${j.id}`,
          jobTemplateId: j.id,
          name: j.name,
          duration: j.defaultDuration,
          start: actStart,
          end: actEnd,
          cost: j.costWeight || 1000,
          responsible: j.defaultResponsible || 'EQUIPE GERAL',
          progress: 0,
          predecessors: [],
          successors: [],
        }));

        activities.push({
          id: `act_${slugifySchedule(flr.name)}_${sPkg.id}`,
          serviceId: sPkg.id,
          floorId: flr.id,
          line: ((pIdx % 3) + 1),
          start: actStart,
          end: actEnd,
          duration: sPkg.defaultDuration,
          cost: sPkg.defaultTotalCost,
          responsible: sPkg.defaultResponsible,
          progress: 0,
          predecessorIds: predIds,
          successorIds: [],
          dependencyRules: rules,
          jobs: actJobs,
        });
      });

      // Avança a data base para o próximo pacote
      previousServiceLastFloorEnd = addWorkingDays(floorStartDate, rhythm + 1, currentState.calendar);
    });
  });

  // 5. Aplica os Vínculos Inter-Raias (Conectores entre Raias)
  macroflow.interLinks.forEach((link) => {
    const sSw = macroflow.swimlanes.find((s) => s.id === link.sourceSwimlaneId);
    const tSw = macroflow.swimlanes.find((s) => s.id === link.targetSwimlaneId);
    const sPkg = serviceByPkgId.get(link.sourcePackageId);
    const tPkg = serviceByPkgId.get(link.targetPackageId);

    if (!sPkg || !tPkg || !sSw || !tSw) return;

    // Se for vínculo com lag de pavimentos (ex: Torre -> Fachada após 5 pavimentos)
    if (link.type === 'floor_lag') {
      const sourceGrp = groupByName.get((sSw.targetGroupName || sSw.name).toLowerCase().trim());
      const targetGrp = groupByName.get((tSw.targetGroupName || tSw.name).toLowerCase().trim());
      if (sourceGrp && targetGrp) {
        const sourceFloors = floors.filter((f) => f.replicationGroupId === sourceGrp.id);
        const triggerFloor = sourceFloors[Math.min(sourceFloors.length - 1, Math.max(0, link.lagValue - 1))];
        if (triggerFloor) {
          const triggerAct = activities.find(
            (a) => a.serviceId === sPkg.id && a.floorId === triggerFloor.id
          );
          const firstTargetAct = activities.find((a) => a.serviceId === tPkg.id);
          if (triggerAct && firstTargetAct) {
            if (!firstTargetAct.predecessorIds.includes(triggerAct.id)) {
              firstTargetAct.predecessorIds.push(triggerAct.id);
            }
          }
        }
      }
    } else {
      // Vínculo tradicional Término do último da origem -> Início do primeiro do destino
      const sourceActs = activities.filter((a) => a.serviceId === sPkg.id);
      const targetActs = activities.filter((a) => a.serviceId === tPkg.id);
      if (sourceActs.length > 0 && targetActs.length > 0) {
        const lastSource = sourceActs[sourceActs.length - 1];
        const firstTarget = targetActs[0];
        if (!firstTarget.predecessorIds.includes(lastSource.id)) {
          firstTarget.predecessorIds.push(lastSource.id);
        }
      }
    }
  });

  return {
    ...currentState,
    replicationGroups: existingGroups,
    floors,
    services,
    activities,
  };
}

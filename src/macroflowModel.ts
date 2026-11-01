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

// =========================================================================
// MODELO PADRÃO COMPLETO BASEADO NA PLANILHA DO USUÁRIO
// =========================================================================
export function getDefaultMacroflowModel(): MacroflowProjectData {
  const swimlanes: MacroflowSwimlane[] = [
    {
      id: 'sw_milestones',
      name: 'MARCOS DA OBRA',
      category: 'milestones',
      color: '#6366f1',
      packages: [
        { id: 'm_inicio', name: 'INÍCIO DA OBRA', color: '#4f46e5', rhythmText: '0d - marco', rhythmDays: 0, position: 1, colIndex: 4, isMilestone: true, jobs: [] },
        { id: 'm_term_estrutura', name: 'TÉRMINO ESTRUTURA', color: '#3b82f6', rhythmText: '0d - marco', rhythmDays: 0, position: 2, colIndex: 24, isMilestone: true, jobs: [] },
        { id: 'm_term_alvenaria', name: 'TÉRMINO ALVENARIA', color: '#0ea5e9', rhythmText: '0d - marco', rhythmDays: 0, position: 3, colIndex: 26, isMilestone: true, jobs: [] },
        { id: 'm_term_fachada', name: 'TÉRMINO FACHADA', color: '#10b981', rhythmText: '0d - marco', rhythmDays: 0, position: 4, colIndex: 27, isMilestone: true, jobs: [] },
        { id: 'm_smop', name: 'ENTRADA SMOP', color: '#f59e0b', rhythmText: '0d - marco', rhythmDays: 0, position: 5, colIndex: 29, isMilestone: true, jobs: [] },
        { id: 'm_cvco', name: 'ENTRADA CVCO', color: '#f97316', rhythmText: '0d - marco', rhythmDays: 0, position: 6, colIndex: 31, isMilestone: true, jobs: [] },
        { id: 'm_vist_smop', name: 'VISTORIA SMOP', color: '#ef4444', rhythmText: '0d - marco', rhythmDays: 0, position: 7, colIndex: 32, isMilestone: true, jobs: [] },
        { id: 'm_vist_bombeiros', name: 'VIST. BOMBEIROS', color: '#dc2626', rhythmText: '0d - marco', rhythmDays: 0, position: 8, colIndex: 33, isMilestone: true, jobs: [] },
        { id: 'm_vist_cvco', name: 'VISTORIA CVCO', color: '#9333ea', rhythmText: '0d - marco', rhythmDays: 0, position: 9, colIndex: 34, isMilestone: true, jobs: [] },
        { id: 'm_clientes', name: 'ENTREGA CLIENTES', color: '#059669', rhythmText: '0d - marco', rhythmDays: 0, position: 10, colIndex: 35, isMilestone: true, jobs: [] },
      ],
    },
    {
      id: 'sw_external',
      name: 'ÁREAS EXTERNAS / COMUNS',
      category: 'external',
      color: '#059669',
      targetGroupName: 'Áreas Externas',
      packages: [
        {
          id: 'pkg_ext_preliminares',
          name: 'SERVIÇOS PRELIMINARES',
          color: '#10b981',
          rhythmText: '15d - por pacote',
          rhythmDays: 15,
          position: 1, colIndex: 3,
          jobs: [
            { id: 'j_p1', name: 'SERV DE DEMOLIÇÃO DE EDIFICAÇÃO', defaultDurationDays: 5 },
            { id: 'j_p2', name: 'LOCAÇÃO DE CONTAINER PARA ALMOXARIFADO', defaultDurationDays: 2 },
            { id: 'j_p3', name: 'SERV. LIMPEZA DE TERRENO', defaultDurationDays: 4 },
            { id: 'j_p4', name: 'SERV. CORTE E RETIRADA DE ÁRVORES', defaultDurationDays: 3 },
            { id: 'j_p5', name: 'MO INST DE PLACAS DE CANTEIRO', defaultDurationDays: 1 },
            { id: 'j_p6', name: 'MO INSTALAÇÃO DE TAPUME', defaultDurationDays: 3 },
            { id: 'j_p7', name: 'LOCAÇÃO DE CONTAINER SIMPLES COM BWC', defaultDurationDays: 2 },
            { id: 'j_p8', name: 'Ligações provisórias água e esgoto, energia e internet', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_ext_instalacoes_prov',
          name: 'INSTALAÇÕES PROVISÓRIAS',
          color: '#047857',
          rhythmText: '30d - por pacote',
          rhythmDays: 30,
          position: 2, colIndex: 4,
          jobs: [
            { id: 'j_ip1', name: 'MO montagem de barracão obra', defaultDurationDays: 8 },
            { id: 'j_ip2', name: '*Áreas de vivência : Refeitório', defaultDurationDays: 5 },
            { id: 'j_ip3', name: '*Áreas de vivência : Instalações sanitárias', defaultDurationDays: 5 },
            { id: 'j_ip4', name: '*Central de armação', defaultDurationDays: 4 },
            { id: 'j_ip5', name: '*Central de carpintaria', defaultDurationDays: 4 },
            { id: 'j_ip6', name: '*Áreas de vivência : Engenharia', defaultDurationDays: 3 },
            { id: 'j_ip7', name: '*Áreas de vivência : Almoxarifado', defaultDurationDays: 3 },
            { id: 'j_ip8', name: '*Baias de descarte de material', defaultDurationDays: 2 },
            { id: 'j_ip9', name: 'MO execução de caminho seguro', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_ext_contencao',
          name: 'CONTENÇÃO',
          color: '#0d9488',
          rhythmText: '20d - por pvto',
          rhythmDays: 20,
          position: 3, colIndex: 5,
          jobs: [
            { id: 'j_cnt1', name: 'MO locação de obra', defaultDurationDays: 2 },
            { id: 'j_cnt2', name: 'SERV fornecimento compactação rachão', defaultDurationDays: 4 },
            { id: 'j_cnt3', name: 'MO perfuração estacas d=30', defaultDurationDays: 5 },
            { id: 'j_cnt4', name: 'MO perfuração estacas d=40', defaultDurationDays: 5 },
            { id: 'j_cnt5', name: 'MO perfuração estacas d=50', defaultDurationDays: 5 },
            { id: 'j_cnt6', name: 'MO perfuração estacas d=60', defaultDurationDays: 5 },
            { id: 'j_cnt7', name: 'SERV concreto bombeado', defaultDurationDays: 3 },
            { id: 'j_cnt8', name: 'SERV. Acompanhamento topografico', defaultDurationDays: 4 },
            { id: 'j_cnt9', name: 'SERV. Movimentação de solo interna para perfuração', defaultDurationDays: 4 },
            { id: 'j_cnt10', name: 'MO montagem e disposição de armaduras', defaultDurationDays: 5 },
            { id: 'j_cnt11', name: 'SERV retirada de material excedente de escavação', defaultDurationDays: 4 },
          ],
        },
        {
          id: 'pkg_ext_muros',
          name: 'MUROS',
          color: '#15803d',
          rhythmText: '10d - cada 200 m2',
          rhythmDays: 10,
          position: 4, colIndex: 22,
          jobs: [
            { id: 'j_mur1', name: 'MO marcação de alvenaria', defaultDurationDays: 2 },
            { id: 'j_mur2', name: 'MO execução de alvenaria', defaultDurationDays: 6 },
            { id: 'j_mur3', name: 'MO instalações elétricas - tubulações em paredes', defaultDurationDays: 3 },
            { id: 'j_mur4', name: 'MO instalações hidráulicas - Ramais de parede', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_ext_emboco_muros',
          name: 'EMBOÇO MUROS',
          color: '#166534',
          rhythmText: '10d - cada 200 m2',
          rhythmDays: 10,
          position: 5, colIndex: 23,
          jobs: [
            { id: 'j_emb1', name: 'MO Chapisco externo', defaultDurationDays: 3 },
            { id: 'j_emb2', name: 'MO Emboço externo', defaultDurationDays: 5 },
            { id: 'j_emb3', name: 'MO Regularização para impermeabilização com manta', defaultDurationDays: 3 },
            { id: 'j_emb4', name: 'MO montagem de andaimes', defaultDurationDays: 2 },
            { id: 'j_emb5', name: 'MO desmontagem de andaimes', defaultDurationDays: 1 },
          ],
        },
        {
          id: 'pkg_ext_imperm1',
          name: 'IMPERM. EXT 1',
          color: '#14b8a6',
          rhythmText: '15d',
          rhythmDays: 15,
          position: 6, colIndex: 24,
          jobs: [
            { id: 'j_imp1', name: 'MO Impermeabilização com manta asfáltica', defaultDurationDays: 6 },
            { id: 'j_imp2', name: 'MO Proteção mecânica', defaultDurationDays: 4 },
            { id: 'j_imp3', name: 'MO Colocação de tela galvanizada sobre manta', defaultDurationDays: 3 },
            { id: 'j_imp4', name: 'MO Emboço externo', defaultDurationDays: 4 },
          ],
        },
        {
          id: 'pkg_ext_redes',
          name: 'REDES EXTERNAS',
          color: '#0891b2',
          rhythmText: '15d - por evento',
          rhythmDays: 15,
          position: 7, colIndex: 25,
          jobs: [
            { id: 'j_red1', name: 'SERV. Reforço de rede Copel', defaultDurationDays: 8 },
            { id: 'j_red2', name: 'SERV. Reforço de rede Sanepar', defaultDurationDays: 7 },
          ],
        },
        {
          id: 'pkg_ext_caixas',
          name: 'CAIXAS E PASSAGENS',
          color: '#0e7490',
          rhythmText: '15d - por evento',
          rhythmDays: 15,
          position: 8, colIndex: 26,
          jobs: [
            { id: 'j_cx1', name: 'Execução de caixas de passagem de esgoto no térreo', defaultDurationDays: 4 },
            { id: 'j_cx2', name: 'Execução de caixas de passagem pluviais no térreo', defaultDurationDays: 4 },
            { id: 'j_cx3', name: 'Execução de caixas de gordura no térreo', defaultDurationDays: 3 },
            { id: 'j_cx4', name: 'Ligação definitiva posicionada', defaultDurationDays: 4 },
          ],
        },
        {
          id: 'pkg_ext_regul_pisos',
          name: 'REGUL. DE PISOS 2',
          color: '#0284c7',
          rhythmText: '10d - por pvto',
          rhythmDays: 10,
          position: 9, colIndex: 27,
          jobs: [
            { id: 'j_rp1', name: 'MO contrapiso com caída para impermeabilização (ático)', defaultDurationDays: 4 },
            { id: 'j_rp2', name: 'MO regularização de cantos para impermeabilização', defaultDurationDays: 3 },
            { id: 'j_rp3', name: 'MO contrapiso com caída para impermeabilização (cobertura)', defaultDurationDays: 4 },
            { id: 'j_rp4', name: 'Colocação de manta acústica', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_ext_imperm3',
          name: 'IMPERM. EXT 3',
          color: '#0369a1',
          rhythmText: '10d - cada 200 m2',
          rhythmDays: 10,
          position: 10, colIndex: 28,
          jobs: [
            { id: 'j_im3_1', name: 'MO Impermeabilização com manta asfáltica', defaultDurationDays: 4 },
            { id: 'j_im3_2', name: 'MO Proteção mecânica', defaultDurationDays: 3 },
            { id: 'j_im3_3', name: 'Impermeabilização do térreo', defaultDurationDays: 4 },
            { id: 'j_im3_4', name: 'Proteção mecânica', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_ext_pisos_ext',
          name: 'PISOS EXTERNOS',
          color: '#1e40af',
          rhythmText: '10d - cada 200 m2',
          rhythmDays: 10,
          position: 11, colIndex: 29,
          jobs: [
            { id: 'j_pe1', name: 'MO Revestimento cerâmico', defaultDurationDays: 6 },
            { id: 'j_pe2', name: 'MO Rodapés em revestimento cerâmico', defaultDurationDays: 4 },
          ],
        },
        {
          id: 'pkg_ext_estrut_cond',
          name: 'ESTRUTURAS COND.',
          color: '#4338ca',
          rhythmText: '30d',
          rhythmDays: 30,
          position: 12, colIndex: 30,
          jobs: [
            { id: 'j_ec1', name: 'MO montagem e desmontagem de formas', defaultDurationDays: 8 },
            { id: 'j_ec2', name: 'MO montagem e disposição de armaduras', defaultDurationDays: 7 },
            { id: 'j_ec3', name: 'MO lançamento do concreto', defaultDurationDays: 4 },
            { id: 'j_ec4', name: 'MO marcação de alvenaria', defaultDurationDays: 3 },
            { id: 'j_ec5', name: 'MO execução de alvenaria', defaultDurationDays: 6 },
            { id: 'j_ec6', name: 'MO vergas e contravergas in-loco', defaultDurationDays: 3 },
            { id: 'j_ec7', name: 'MO Instalações elétricas', defaultDurationDays: 5 },
            { id: 'j_ec8', name: 'MO Instalações hidráulica', defaultDurationDays: 5 },
            { id: 'j_ec9', name: 'MO Chapisco interno', defaultDurationDays: 4 },
            { id: 'j_ec10', name: 'MO Emboço interno', defaultDurationDays: 6 },
          ],
        },
        {
          id: 'pkg_ext_acab_cond',
          name: 'ACABAMENTOS COND.',
          color: '#6d28d9',
          rhythmText: '30d',
          rhythmDays: 30,
          position: 13, colIndex: 31,
          jobs: [
            { id: 'j_ac1', name: 'MO revestimento cerâmico parede', defaultDurationDays: 7 },
            { id: 'j_ac2', name: 'MO revestimento cerâmico piso', defaultDurationDays: 7 },
            { id: 'j_ac3', name: 'MO Rejuntamento de parede', defaultDurationDays: 4 },
            { id: 'j_ac4', name: 'MO Rejuntamento de piso', defaultDurationDays: 4 },
            { id: 'j_ac5', name: 'MO instalação de portas', defaultDurationDays: 4 },
            { id: 'j_ac6', name: 'MO Instalação de louças', defaultDurationDays: 4 },
            { id: 'j_ac7', name: 'MO Pintura completa', defaultDurationDays: 8 },
            { id: 'j_ac8', name: 'MO Quadros elétricos', defaultDurationDays: 4 },
            { id: 'j_ac9', name: 'MO Acabamentos elétricas', defaultDurationDays: 4 },
            { id: 'j_ac10', name: 'MO Limpeza fina', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_ext_paisagismo',
          name: 'PAISAGISMO',
          color: '#15803d',
          rhythmText: '10d - cada 200 m2',
          rhythmDays: 10,
          position: 14, colIndex: 32,
          jobs: [
            { id: 'j_pai1', name: 'MO Execução de calçadas em piso intertravado', defaultDurationDays: 5 },
            { id: 'j_pai2', name: 'MO Plantio de gramas', defaultDurationDays: 3 },
            { id: 'j_pai3', name: 'MO Plantio de árvores', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_ext_energia',
          name: 'ENTRADA DE ENERGIA',
          color: '#eab308',
          rhythmText: '15d - por evento',
          rhythmDays: 15,
          position: 15, colIndex: 33,
          jobs: [
            { id: 'j_en1', name: 'MO Instalação de poste definitivo', defaultDurationDays: 3 },
            { id: 'j_en2', name: 'MO Caixas elétricas para entrada de energia', defaultDurationDays: 3 },
            { id: 'j_en3', name: 'MO Chumbamento de caixas para entrada de energia', defaultDurationDays: 3 },
            { id: 'j_en4', name: 'MO Montagem de caixas de entrada de energia', defaultDurationDays: 3 },
            { id: 'j_en5', name: 'MO Fiação de entrada de energia', defaultDurationDays: 4 },
            { id: 'j_en6', name: 'MO Fiação até QDG', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_ext_textura',
          name: 'TEXTURA',
          color: '#d97706',
          rhythmText: '10d - cada 400 m2',
          rhythmDays: 10,
          position: 16, colIndex: 34,
          jobs: [
            { id: 'j_tx1', name: 'MO Aplicação de textura projetada', defaultDurationDays: 5 },
            { id: 'j_tx2', name: 'MO Pintura de pisos', defaultDurationDays: 4 },
            { id: 'j_tx3', name: 'MO montagem de andaimes', defaultDurationDays: 2 },
            { id: 'j_tx4', name: 'MO desmontagem de andaimes', defaultDurationDays: 1 },
          ],
        },
        {
          id: 'pkg_ext_serralheria3',
          name: 'SERRALHERIA 3',
          color: '#475569',
          rhythmText: '10d - cada 300 m2',
          rhythmDays: 10,
          position: 17, colIndex: 35,
          jobs: [
            { id: 'j_sr1', name: 'MO Instalação de Portões metálicos', defaultDurationDays: 3 },
            { id: 'j_sr2', name: 'MO Instalação de Bancos', defaultDurationDays: 2 },
            { id: 'j_sr3', name: 'MO Instalação de Grelhas', defaultDurationDays: 2 },
            { id: 'j_sr4', name: 'MO Instalação de Gradil', defaultDurationDays: 3 },
            { id: 'j_sr5', name: 'MO Instalação de Suportes', defaultDurationDays: 2 },
          ],
        },
      ],
    },
    {
      id: 'sw_basement',
      name: 'SUBSOLOS',
      category: 'basement',
      color: '#475569',
      targetGroupName: 'Subsolo',
      packages: [
        {
          id: 'pkg_sub_escavacao',
          name: 'ESCAVAÇÃO/ATERRO',
          color: '#78716c',
          rhythmText: '15d - por pvto',
          rhythmDays: 15,
          position: 1, colIndex: 5,
          jobs: [
            { id: 'j_se1', name: 'SERV Escavação e retirada de material', defaultDurationDays: 6 },
            { id: 'j_se2', name: 'MO montagem e desmontagem de formas', defaultDurationDays: 4 },
            { id: 'j_se3', name: 'MO Arrasamento de estacas', defaultDurationDays: 4 },
            { id: 'j_se4', name: 'MO montagem e disposição de armaduras', defaultDurationDays: 4 },
            { id: 'j_se5', name: 'MO execução de tirantes protendidos', defaultDurationDays: 4 },
            { id: 'j_se6', name: 'MO execução de guarda-corpo em madeira', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_sub_fundacao',
          name: 'FUNDAÇÃO',
          color: '#57534e',
          rhythmText: '15d - por pvto',
          rhythmDays: 15,
          position: 2, colIndex: 6,
          jobs: [
            { id: 'j_sf1', name: 'SERV retirada de material excedente de escavação', defaultDurationDays: 4 },
            { id: 'j_sf2', name: 'MO montagem e disposição de armaduras', defaultDurationDays: 5 },
            { id: 'j_sf3', name: 'MO perfuração estacas d=60', defaultDurationDays: 4 },
            { id: 'j_sf4', name: 'MO perfuração estacas d=70', defaultDurationDays: 4 },
            { id: 'j_sf5', name: 'MO perfuração estacas d=80', defaultDurationDays: 4 },
            { id: 'j_sf6', name: 'SERV concreto bombeado', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_sub_blocos',
          name: 'BLOCOS E BALDRAMES',
          color: '#44403c',
          rhythmText: '15d - por m3',
          rhythmDays: 15,
          position: 3, colIndex: 7,
          jobs: [
            { id: 'j_sb1', name: 'MO Arrasamento de estacas', defaultDurationDays: 3 },
            { id: 'j_sb2', name: 'MO montagem e desmontagem de formas', defaultDurationDays: 5 },
            { id: 'j_sb3', name: 'SERV concreto bombeado', defaultDurationDays: 3 },
            { id: 'j_sb4', name: 'MO montagem e disposição de armaduras', defaultDurationDays: 5 },
            { id: 'j_sb5', name: 'MO Reaterro manual', defaultDurationDays: 3 },
            { id: 'j_sb6', name: 'MO Compactação à percussão', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_sub_supra',
          name: 'SUPRAESTRUTURA',
          color: '#334155',
          rhythmText: '15d - por pvto',
          rhythmDays: 15,
          position: 4, colIndex: 8,
          jobs: [
            { id: 'j_ss1', name: 'MO montagem e desmontagem de formas', defaultDurationDays: 6 },
            { id: 'j_ss2', name: 'MO montagem e disposição de armaduras', defaultDurationDays: 6 },
            { id: 'j_ss3', name: 'MO montagem de linha de vida', defaultDurationDays: 2 },
            { id: 'j_ss4', name: 'MO montagem de proteção de periferia', defaultDurationDays: 2 },
            { id: 'j_ss5', name: 'MO Instalações elétricas - tubulação em laje', defaultDurationDays: 4 },
            { id: 'j_ss6', name: 'MO Instalações hidráulicas - passantes em vigas e lajes', defaultDurationDays: 4 },
            { id: 'j_ss7', name: 'MO lançamento de concreto', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_sub_drenagem',
          name: 'DRENAGEM (CORTINA)',
          color: '#0284c7',
          rhythmText: '10d - por m3',
          rhythmDays: 10,
          position: 5, colIndex: 9,
          jobs: [
            { id: 'j_sdr1', name: 'MO Instalações hidráulicas - Disposição de tubos de drenagem', defaultDurationDays: 4 },
            { id: 'j_sdr2', name: 'MO Fechamento de cortina com forma', defaultDurationDays: 4 },
            { id: 'j_sdr3', name: 'MO lançamento de concreto', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_sub_infra_lastro',
          name: 'INFRAESTRUTURA LASTRO',
          color: '#0369a1',
          rhythmText: '10d - por ocorrencia',
          rhythmDays: 10,
          position: 6, colIndex: 10,
          jobs: [
            { id: 'j_sil1', name: 'MO Instalações hidráulicas - tubos perfurados drenagem', defaultDurationDays: 4 },
            { id: 'j_sil2', name: 'MO Instalações hidráulicas - tubos de concreto drenagem', defaultDurationDays: 4 },
            { id: 'j_sil3', name: 'MO Instalações hidráulicas - caixas para drenagem', defaultDurationDays: 3 },
            { id: 'j_sil4', name: 'MO Fiação em área comum', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_sub_cisterna',
          name: 'CISTERNA',
          color: '#0e7490',
          rhythmText: '15d - por ocorrencia',
          rhythmDays: 15,
          position: 7, colIndex: 11,
          jobs: [
            { id: 'j_cis1', name: 'MO montagem e desmontagem de formas', defaultDurationDays: 5 },
            { id: 'j_cis2', name: 'MO montagem e disposição de armaduras', defaultDurationDays: 5 },
            { id: 'j_cis3', name: 'MO Instalações hidráulicas - passantes', defaultDurationDays: 3 },
            { id: 'j_cis4', name: 'MO lançamento de concreto', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_sub_contencao_cheias',
          name: 'CONTENÇÃO CHEIAS',
          color: '#0f766e',
          rhythmText: '15d - por ocorrencia',
          rhythmDays: 15,
          position: 8, colIndex: 12,
          jobs: [
            { id: 'j_cch1', name: 'MO montagem e desmontagem de formas', defaultDurationDays: 5 },
            { id: 'j_cch2', name: 'MO montagem e disposição de armaduras', defaultDurationDays: 5 },
            { id: 'j_cch3', name: 'MO lançamento de concreto', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_sub_imperm',
          name: 'IMPERMEABILIZAÇÃO SUB',
          color: '#115e59',
          rhythmText: '10d - cada 100 m3',
          rhythmDays: 10,
          position: 9, colIndex: 14,
          jobs: [
            { id: 'j_ism1', name: 'MO Impermeabilização de Cisterna', defaultDurationDays: 3 },
            { id: 'j_ism2', name: 'MO Impermeabilização de Contenção de cheias', defaultDurationDays: 3 },
            { id: 'j_ism3', name: 'MO Impermeabilização de Cortinas', defaultDurationDays: 4 },
            { id: 'j_ism4', name: 'MO Impermeabilização de Arrimos', defaultDurationDays: 4 },
          ],
        },
        {
          id: 'pkg_sub_lastro',
          name: 'LASTRO',
          color: '#64748b',
          rhythmText: '10d - cada 100 m3',
          rhythmDays: 10,
          position: 10, colIndex: 15,
          jobs: [
            { id: 'j_lst1', name: 'MO Instalação provisória de iluminação', defaultDurationDays: 2 },
            { id: 'j_lst2', name: 'SERV fornecimento de brita para base', defaultDurationDays: 3 },
            { id: 'j_lst3', name: 'MO Compactação à percussão', defaultDurationDays: 3 },
            { id: 'j_lst4', name: 'MO disposição de lona e chapa de isopor', defaultDurationDays: 2 },
            { id: 'j_lst5', name: 'MO montagem e desmontagem de formas', defaultDurationDays: 3 },
            { id: 'j_lst6', name: 'MO montagem e disposição de armaduras', defaultDurationDays: 3 },
            { id: 'j_lst7', name: 'MO lançamento de concreto', defaultDurationDays: 2 },
            { id: 'j_lst8', name: 'MO acabamento queimado em laje', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_sub_alvenaria_hall',
          name: 'ALVENARIA HALL',
          color: '#e11d48',
          rhythmText: '10d - por pvto',
          rhythmDays: 10,
          position: 11, colIndex: 21,
          jobs: [
            { id: 'j_sah1', name: 'MO marcação de alvenaria', defaultDurationDays: 2 },
            { id: 'j_sah2', name: 'MO execução de alvenaria', defaultDurationDays: 6 },
            { id: 'j_sah3', name: 'MO vergas e contravergas in-loco', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_sub_emboco',
          name: 'EMBOÇO SUB',
          color: '#be123c',
          rhythmText: '10d - por pvto',
          rhythmDays: 10,
          position: 12, colIndex: 22,
          jobs: [
            { id: 'j_seb1', name: 'MO encunhamento de alvenaria', defaultDurationDays: 2 },
            { id: 'j_seb2', name: 'MO Emboço interno', defaultDurationDays: 6 },
            { id: 'j_seb3', name: 'MO Gesso Liso', defaultDurationDays: 4 },
          ],
        },
        {
          id: 'pkg_sub_regul_tetos',
          name: 'REGULARIZAÇÃO TETOS',
          color: '#9f1239',
          rhythmText: '10d - cada 1000m2',
          rhythmDays: 10,
          position: 13, colIndex: 23,
          jobs: [
            { id: 'j_srt1', name: 'MO Regularização de superfície de lajes, vigas e pilares', defaultDurationDays: 10 },
          ],
        },
        {
          id: 'pkg_sub_pintura_estrut',
          name: 'PINTURA DA ESTRUTURA',
          color: '#4338ca',
          rhythmText: '10d - cada 1000m2',
          rhythmDays: 10,
          position: 14, colIndex: 25,
          jobs: [
            { id: 'j_spe1', name: 'MO Pintura 1ª Demão', defaultDurationDays: 4 },
            { id: 'j_spe2', name: 'MO Retoque massa corrida', defaultDurationDays: 3 },
            { id: 'j_spe3', name: 'MO Pintura 2ª Demão', defaultDurationDays: 4 },
          ],
        },
        {
          id: 'pkg_sub_infra_teto',
          name: 'INFRA TETO',
          color: '#3730a3',
          rhythmText: '15d - cada 1000m2',
          rhythmDays: 15,
          position: 15, colIndex: 26,
          jobs: [
            { id: 'j_sit1', name: 'MO Fixação de tubulação de elétrica/telefone no teto', defaultDurationDays: 4 },
            { id: 'j_sit2', name: 'MO Fixação de tubulação de ESG/PLUV', defaultDurationDays: 4 },
            { id: 'j_sit3', name: 'MO Fixação de tubulação de AQ/AF', defaultDurationDays: 4 },
            { id: 'j_sit4', name: 'MO Fixação de tubulação de Incêndio', defaultDurationDays: 4 },
          ],
        },
        {
          id: 'pkg_sub_pintura_tubos',
          name: 'PINTURA DE TUBULAÇÕES',
          color: '#312e81',
          rhythmText: '10d - cada 1000m2',
          rhythmDays: 10,
          position: 16, colIndex: 28,
          jobs: [
            { id: 'j_spt1', name: 'MO Pintura de tubulações aparentes em teto', defaultDurationDays: 8 },
          ],
        },
        {
          id: 'pkg_sub_parede_falsa',
          name: 'PAREDE FALSA',
          color: '#581c87',
          rhythmText: '10d - cada 200m2',
          rhythmDays: 10,
          position: 17, colIndex: 29,
          jobs: [
            { id: 'j_spf1', name: 'MO execução de alvenaria', defaultDurationDays: 5 },
            { id: 'j_spf2', name: 'MO Execução de parede falsa em forro pvc/metalon', defaultDurationDays: 5 },
          ],
        },
        {
          id: 'pkg_sub_pintura_paredes',
          name: 'PINTURA DE PAREDES',
          color: '#6b21a8',
          rhythmText: '10d - cada 300m2',
          rhythmDays: 10,
          position: 18, colIndex: 30,
          jobs: [
            { id: 'j_spp1', name: 'MO Pintura 1ªdemão paredes', defaultDurationDays: 4 },
            { id: 'j_spp2', name: 'MO Pintura 1ªdemão faixas', defaultDurationDays: 3 },
            { id: 'j_spp3', name: 'MO Pintura 2ªdemão paredes', defaultDurationDays: 4 },
            { id: 'j_spp4', name: 'MO Pintura 2ªdemão faixas', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_sub_pintura_pisos',
          name: 'PINTURA EM PISOS',
          color: '#7e22ce',
          rhythmText: '10d - cada 300m2',
          rhythmDays: 10,
          position: 19, colIndex: 31,
          jobs: [
            { id: 'j_spi1', name: 'MO Pintura 1ªdemão vagas piso', defaultDurationDays: 5 },
            { id: 'j_spi2', name: 'MO Pintura 2ªdemão vagas piso', defaultDurationDays: 5 },
          ],
        },
        {
          id: 'pkg_sub_limpeza',
          name: 'LIMPEZA FINA',
          color: '#15803d',
          rhythmText: '10d - cada 1000m2',
          rhythmDays: 10,
          position: 20, colIndex: 32,
          jobs: [
            { id: 'j_slf1', name: 'MO Limpeza fina de obra', defaultDurationDays: 10 },
          ],
        },
      ],
    },
    {
      id: 'sw_tower',
      name: 'TORRE - PAVIMENTO TIPO',
      category: 'tower',
      color: '#0284c7',
      targetGroupName: 'Torre',
      packages: [
        {
          id: 'pkg_torre_estrutura',
          name: 'ESTRUTURA',
          color: '#0369a1',
          rhythmText: '10d - por pvto',
          rhythmDays: 10,
          position: 1, colIndex: 9,
          jobs: [
            { id: 'j_te1', name: 'MO montagem e desmontagem de formas', defaultDurationDays: 6 },
            { id: 'j_te2', name: 'MO montagem e disposição de armaduras', defaultDurationDays: 6 },
            { id: 'j_te3', name: 'MO montagem de linha de vida', defaultDurationDays: 2 },
            { id: 'j_te4', name: 'MO montagem de proteção de periferia', defaultDurationDays: 2 },
            { id: 'j_te5', name: 'MO Instalações elétricas - tubulação em laje', defaultDurationDays: 4 },
            { id: 'j_te6', name: 'MO montagem de bandejão primário', defaultDurationDays: 2 },
            { id: 'j_te7', name: 'MO montagem de bandejão secundário', defaultDurationDays: 2 },
            { id: 'j_te8', name: 'MO desmontagem de bandejão secundário', defaultDurationDays: 2 },
            { id: 'j_te9', name: 'MO Instalações hidráulicas - passantes em lajes', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_torre_concreto',
          name: 'CONCRETO',
          color: '#0ea5e9',
          rhythmText: '1d - por pvto',
          rhythmDays: 1,
          position: 2, colIndex: 10,
          jobs: [
            { id: 'j_tc1', name: 'MO lançamento de concreto', defaultDurationDays: 1 },
            { id: 'j_tc2', name: 'MO acabamento desempenado em laje', defaultDurationDays: 1 },
            { id: 'j_tc3', name: 'SERV concreto bombeado', defaultDurationDays: 1 },
          ],
        },
        {
          id: 'pkg_torre_alvenaria',
          name: 'ALVENARIA',
          color: '#f97316',
          rhythmText: '10d - por pvto',
          rhythmDays: 10,
          position: 3, colIndex: 12,
          jobs: [
            { id: 'j_ta1', name: 'MO chapisco interno de estrutura', defaultDurationDays: 2 },
            { id: 'j_ta2', name: 'MO fixação de tela galvanizada em estrutura', defaultDurationDays: 2 },
            { id: 'j_ta3', name: 'MO marcação de alvenaria', defaultDurationDays: 2 },
            { id: 'j_ta4', name: 'MO execução de alvenaria', defaultDurationDays: 6 },
            { id: 'j_ta5', name: 'MO vergas e contravergas in-loco', defaultDurationDays: 3 },
            { id: 'j_ta6', name: 'SERV fornecimento de argamassa estabilizada', defaultDurationDays: 4 },
            { id: 'j_ta7', name: 'MO nichos de personalização', defaultDurationDays: 2 },
            { id: 'j_ta8', name: 'MO fundos de central de aspiração', defaultDurationDays: 2 },
            { id: 'j_ta9', name: 'Instalação da churrasqueiras', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_torre_instalacoes1',
          name: 'INSTALAÇÕES 1',
          color: '#eab308',
          rhythmText: '10d - por pvto',
          rhythmDays: 10,
          position: 4, colIndex: 13,
          jobs: [
            { id: 'j_ti1_1', name: 'MO instalações elétricas - tubulações e caixas em paredes', defaultDurationDays: 5 },
            { id: 'j_ti1_2', name: 'MO instalações hidráulicas - Prumadas de ESG/PLUV', defaultDurationDays: 5 },
            { id: 'j_ti1_3', name: 'MO instalações hidráulicas - Ramais de ESG/PLUV de teto', defaultDurationDays: 5 },
            { id: 'j_ti1_4', name: 'MO instalações hidráulicas - Prumadas de AQ/AF', defaultDurationDays: 4 },
            { id: 'j_ti1_5', name: 'MO instalações hidráulicas - Ramais de parede e teto', defaultDurationDays: 4 },
            { id: 'j_ti1_6', name: 'MO Instalação provisória de iluminação corredores', defaultDurationDays: 2 },
            { id: 'j_ti1_7', name: 'MO encunhamento de alvenaria', defaultDurationDays: 2 },
            { id: 'j_ti1_8', name: 'MO Instalação provisória de água e esgoto', defaultDurationDays: 2 },
            { id: 'j_ti1_9', name: 'MO Fiação em área comum', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_torre_emboco',
          name: 'EMBOÇO/GL',
          color: '#d97706',
          rhythmText: '10d - por pvto',
          rhythmDays: 10,
          position: 5, colIndex: 14,
          jobs: [
            { id: 'j_tem1', name: 'MO teste hidrostático de AF e AQ', defaultDurationDays: 2 },
            { id: 'j_tem2', name: 'MO Chapisco interno', defaultDurationDays: 3 },
            { id: 'j_tem3', name: 'MO Emboço interno', defaultDurationDays: 6 },
            { id: 'j_tem4', name: 'SERV Instalações de gás', defaultDurationDays: 3 },
            { id: 'j_tem5', name: 'MO Gesso Liso', defaultDurationDays: 5 },
          ],
        },
        {
          id: 'pkg_torre_contrapiso',
          name: 'CONTRAPISO',
          color: '#84cc16',
          rhythmText: '10d - por pvto',
          rhythmDays: 10,
          position: 6, colIndex: 15,
          jobs: [
            { id: 'j_tcp1', name: 'MO contrapiso dos corredores', defaultDurationDays: 4 },
            { id: 'j_tcp2', name: 'MO contrapiso nivelado áreas privativas', defaultDurationDays: 5 },
            { id: 'j_tcp3', name: 'MO contrapiso com caída áreas privativas', defaultDurationDays: 4 },
            { id: 'j_tcp4', name: 'MO contrapiso com caída áreas comuns internas', defaultDurationDays: 3 },
            { id: 'j_tcp5', name: 'MO contrapiso de floreiras', defaultDurationDays: 2 },
            { id: 'j_tcp6', name: 'MO colocação de manta acústica', defaultDurationDays: 2 },
            { id: 'j_tcp7', name: 'MO contrapiso escadarias', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_torre_drywall1',
          name: 'DRYWALL 1',
          color: '#22c55e',
          rhythmText: '10d - por pvto',
          rhythmDays: 10,
          position: 7, colIndex: 16,
          jobs: [
            { id: 'j_tdw1_1', name: 'MO fechamento em drywall', defaultDurationDays: 5 },
            { id: 'j_tdw1_2', name: 'MO de estrutura para DW', defaultDurationDays: 4 },
            { id: 'j_tdw1_3', name: 'MO instalações elétricas - tubulações em paredes', defaultDurationDays: 3 },
            { id: 'j_tdw1_4', name: 'MO instalações de aspiração central', defaultDurationDays: 2 },
            { id: 'j_tdw1_5', name: 'MO fechamento de churrasqueiras', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_torre_drywall2',
          name: 'DRYWALL 2',
          color: '#16a34a',
          rhythmText: '10d - por pvto',
          rhythmDays: 10,
          position: 8, colIndex: 17,
          jobs: [
            { id: 'j_tdw2_1', name: 'MO Infraestrutura ar-condicionado', defaultDurationDays: 4 },
            { id: 'j_tdw2_2', name: 'MO de chapeamento 1F DW', defaultDurationDays: 4 },
            { id: 'j_tdw2_3', name: 'MO tratamento de juntas DW', defaultDurationDays: 4 },
            { id: 'j_tdw2_4', name: 'MO porta de sacrifício', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_torre_imperm',
          name: 'IMPERMEABILIZAÇÃO INT',
          color: '#06b6d4',
          rhythmText: '10d - por pvto',
          rhythmDays: 10,
          position: 9, colIndex: 18,
          jobs: [
            { id: 'j_tip1', name: 'MO Impermeabilização argamassa polimérica em box', defaultDurationDays: 3 },
            { id: 'j_tip2', name: 'MO Impermeabilização argamassa polimérica em banheiro', defaultDurationDays: 3 },
            { id: 'j_tip3', name: 'MO Impermeabilização argamassa polimérica em cozinha/AS', defaultDurationDays: 3 },
            { id: 'j_tip4', name: 'MO Teste de estanqueidade', defaultDurationDays: 3 },
            { id: 'j_tip5', name: 'MO Impermeabilização com manta em floreira', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_torre_revest_ceramico',
          name: 'REVEST. CERÂMICO',
          color: '#3b82f6',
          rhythmText: '10d - por pvto',
          rhythmDays: 10,
          position: 10, colIndex: 19,
          jobs: [
            { id: 'j_trc1', name: 'MO revestimento cerâmico parede', defaultDurationDays: 5 },
            { id: 'j_trc2', name: 'MO revestimento cerâmico piso', defaultDurationDays: 5 },
            { id: 'j_trc3', name: 'MO Rejuntamento de parede', defaultDurationDays: 3 },
            { id: 'j_trc4', name: 'MO Rejuntamento de piso', defaultDurationDays: 3 },
            { id: 'j_trc5', name: 'MO Rodapés em revestimento cerâmico', defaultDurationDays: 2 },
            { id: 'j_trc6', name: 'MO Instalação de soleiras em granito', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_torre_instalacoes2',
          name: 'INSTALAÇÕES 2',
          color: '#6366f1',
          rhythmText: '5d - por pvto',
          rhythmDays: 5,
          position: 11, colIndex: 20,
          jobs: [
            { id: 'j_ti2_1', name: 'MO fiação em áreas privativas', defaultDurationDays: 3 },
            { id: 'j_ti2_2', name: 'MO instalações elétricas - Montagem de QD', defaultDurationDays: 3 },
            { id: 'j_ti2_3', name: 'MO Infraestrutura exaustão bwc', defaultDurationDays: 2 },
            { id: 'j_ti2_4', name: 'MO infraestrutura dutos e coifas', defaultDurationDays: 2 },
            { id: 'j_ti2_5', name: 'MO instalações elétricas - suporte e miolo', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_torre_forros',
          name: 'FORROS',
          color: '#8b5cf6',
          rhythmText: '10d - por pvto',
          rhythmDays: 10,
          position: 12, colIndex: 21,
          jobs: [
            { id: 'j_tfo1', name: 'MO forro gesso em placa', defaultDurationDays: 5 },
            { id: 'j_tfo2', name: 'MO tabicas para forro de gesso', defaultDurationDays: 3 },
            { id: 'j_tfo3', name: 'MO forro em DW', defaultDurationDays: 4 },
            { id: 'j_tfo4', name: 'MO instalação de alçapões', defaultDurationDays: 2 },
            { id: 'j_tfo5', name: 'MO rebaixos e cortineiros', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_torre_pintura1',
          name: 'PINTURA 1',
          color: '#a855f7',
          rhythmText: '10d - por pvto',
          rhythmDays: 10,
          position: 13, colIndex: 22,
          jobs: [
            { id: 'j_tp1_1', name: 'MO Massa corrida 1ª demão', defaultDurationDays: 4 },
            { id: 'j_tp1_2', name: 'MO Lixamento 1', defaultDurationDays: 3 },
            { id: 'j_tp1_3', name: 'MO Massa corrida 2ª demão', defaultDurationDays: 4 },
            { id: 'j_tp1_4', name: 'MO Lixamento 2', defaultDurationDays: 3 },
            { id: 'j_tp1_5', name: 'MO Limpeza e selador', defaultDurationDays: 2 },
            { id: 'j_tp1_6', name: 'MO Pintura 1a demão', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_torre_desengrosso',
          name: 'DESENGROSSO',
          color: '#ec4899',
          rhythmText: '5d - por pvto',
          rhythmDays: 5,
          position: 14, colIndex: 25,
          jobs: [
            { id: 'j_tde1', name: 'MO limpeza grossa', defaultDurationDays: 5 },
          ],
        },
        {
          id: 'pkg_torre_acabamentos',
          name: 'ACABAMENTOS',
          color: '#f43f5e',
          rhythmText: '5d - por pvto',
          rhythmDays: 5,
          position: 15, colIndex: 27,
          jobs: [
            { id: 'j_tac1', name: 'MO Instalação de louças', defaultDurationDays: 3 },
            { id: 'j_tac2', name: 'MO Instalação de tampos', defaultDurationDays: 2 },
            { id: 'j_tac3', name: 'MO Instalação de nichos', defaultDurationDays: 2 },
            { id: 'j_tac4', name: 'MO Instalação de metais', defaultDurationDays: 2 },
            { id: 'j_tac5', name: 'MO regularização para piso especial', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_torre_pisos_esp',
          name: 'PISOS ESPECIAIS',
          color: '#e11d48',
          rhythmText: '5d - por pvto',
          rhythmDays: 5,
          position: 16, colIndex: 28,
          jobs: [
            { id: 'j_tpe1', name: 'MO Pisos vinílicos', defaultDurationDays: 4 },
            { id: 'j_tpe2', name: 'MO instalação de rodapés', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_torre_portas',
          name: 'PORTAS',
          color: '#be123c',
          rhythmText: '5d - por pvto',
          rhythmDays: 5,
          position: 17, colIndex: 29,
          jobs: [
            { id: 'j_tpo1', name: 'MO instalação de portas', defaultDurationDays: 3 },
            { id: 'j_tpo2', name: 'MO instalação de vistas', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_torre_pintura2',
          name: 'PINTURA 2',
          color: '#9f1239',
          rhythmText: '5d - por pvto',
          rhythmDays: 5,
          position: 18, colIndex: 30,
          jobs: [
            { id: 'j_tp2_1', name: 'MO Pintura 2ª demão', defaultDurationDays: 3 },
            { id: 'j_tp2_2', name: 'MO acerto de vão portas', defaultDurationDays: 2 },
            { id: 'j_tp2_3', name: 'MO Aplicação de selantes em portas', defaultDurationDays: 2 },
            { id: 'j_tp2_4', name: 'MO regulagem esquadrias', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_torre_instalacoes3',
          name: 'INSTALAÇÕES 3',
          color: '#4f46e5',
          rhythmText: '5d - por pvto',
          rhythmDays: 5,
          position: 19, colIndex: 31,
          jobs: [
            { id: 'j_ti3_1', name: 'MO Instalações elétricas - luminárias', defaultDurationDays: 2 },
            { id: 'j_ti3_2', name: 'MO Instalações elétricas - espelhos de acabamento', defaultDurationDays: 2 },
            { id: 'j_ti3_3', name: 'MO Instalação de placas de comunicação visual', defaultDurationDays: 1 },
            { id: 'j_ti3_4', name: 'MO Instalação de aquecedores', defaultDurationDays: 2 },
            { id: 'j_ti3_5', name: 'MO instalação de aparelhos ar condicionado', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_torre_personalizacao',
          name: 'PERSONALIZAÇÃO',
          color: '#0891b2',
          rhythmText: '5d - por pvto',
          rhythmDays: 5,
          position: 20, colIndex: 32,
          jobs: [
            { id: 'j_tpz1', name: 'SERV Instalação de espelhos', defaultDurationDays: 2 },
            { id: 'j_tpz2', name: 'SERV Instalação de box', defaultDurationDays: 2 },
            { id: 'j_tpz3', name: 'MO Acabamentos de churrasqueira', defaultDurationDays: 2 },
            { id: 'j_tpz4', name: 'SERV Instalação de ar-condicionado', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_torre_pintura3',
          name: 'PINTURA 3',
          color: '#0284c7',
          rhythmText: '5d - por pvto',
          rhythmDays: 5,
          position: 21, colIndex: 33,
          jobs: [
            { id: 'j_tp3_1', name: 'MO Pintura 3ª demão', defaultDurationDays: 5 },
          ],
        },
        {
          id: 'pkg_torre_limpeza_chk',
          name: 'LIMPEZA FINA E CHECKLIST',
          color: '#059669',
          rhythmText: '5d - por pvto',
          rhythmDays: 5,
          position: 22, colIndex: 34,
          jobs: [
            { id: 'j_tlc1', name: 'MO Limpeza fina', defaultDurationDays: 3 },
            { id: 'j_tlc2', name: 'MO Vistoria interna e checklist', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_torre_decoracao',
          name: 'DECORAÇÃO E REPAROS',
          color: '#16a34a',
          rhythmText: '5d - por pvto',
          rhythmDays: 5,
          position: 23, colIndex: 35,
          jobs: [
            { id: 'j_tdr1', name: 'MO decoração de obra', defaultDurationDays: 3 },
            { id: 'j_tdr2', name: 'MO reparos para checklist', defaultDurationDays: 3 },
          ],
        },
      ],
    },
    {
      id: 'sw_facade',
      name: 'FACHADA',
      category: 'facade',
      color: '#d97706',
      targetGroupName: 'Fachada',
      packages: [
        {
          id: 'pkg_fac_balancim',
          name: 'BALANCIM',
          color: '#b45309',
          rhythmText: '2d - por balancim',
          rhythmDays: 2,
          position: 1, colIndex: 21,
          jobs: [
            { id: 'j_fb1', name: 'MO desmontagem de bandejão secundário', defaultDurationDays: 1 },
            { id: 'j_fb2', name: 'MO suporte para tela de proteção', defaultDurationDays: 1 },
            { id: 'j_fb3', name: 'MO montagem de balancim', defaultDurationDays: 1 },
            { id: 'j_fb4', name: 'MO fixação de tela de proteção', defaultDurationDays: 1 },
            { id: 'j_fb5', name: 'MO lançamento de prumadas de arame de fachada', defaultDurationDays: 1 },
          ],
        },
        {
          id: 'pkg_fac_emboco_ext',
          name: 'EMBOÇO EXT.',
          color: '#92400e',
          rhythmText: '1d - por balancim/pvto',
          rhythmDays: 1,
          position: 2, colIndex: 22,
          jobs: [
            { id: 'j_fe1', name: 'MO preparação e limpeza de fachada para chapisco', defaultDurationDays: 1 },
            { id: 'j_fe2', name: 'MO Fixação de telas da fachada', defaultDurationDays: 1 },
            { id: 'j_fe3', name: 'MO chapisco externo', defaultDurationDays: 1 },
            { id: 'j_fe4', name: 'MO Emboço externo', defaultDurationDays: 1 },
            { id: 'j_fe5', name: 'MO desmontagem de bandejão primário', defaultDurationDays: 1 },
          ],
        },
        {
          id: 'pkg_fac_imp_fachada',
          name: 'IMP. FACHADA',
          color: '#0d9488',
          rhythmText: '2d - por pavimento',
          rhythmDays: 2,
          position: 3, colIndex: 23,
          jobs: [
            { id: 'j_fif1', name: 'MO Impermeabilização de pingadeiras', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_fac_pingadeiras',
          name: 'PINGADEIRAS',
          color: '#0f766e',
          rhythmText: '10d - cada 20 ml floreiras',
          rhythmDays: 10,
          position: 4, colIndex: 24,
          jobs: [
            { id: 'j_fpi1', name: 'MO Impermeabilização de pingadeiras', defaultDurationDays: 3 },
            { id: 'j_fpi2', name: 'MO Assentamento de pingadeiras', defaultDurationDays: 4 },
            { id: 'j_fpi3', name: 'MO tratamento de frisos de fachada', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_fac_floreiras1',
          name: 'FLOREIRAS 1',
          color: '#15803d',
          rhythmText: '1d - por balancim',
          rhythmDays: 1,
          position: 5, colIndex: 25,
          jobs: [
            { id: 'j_ff1', name: 'MO Impermeabilização em floreira', defaultDurationDays: 1 },
          ],
        },
        {
          id: 'pkg_fac_porcelanato',
          name: 'PORCELANATO EXTERNO',
          color: '#0284c7',
          rhythmText: '1d - por balancim',
          rhythmDays: 1,
          position: 6, colIndex: 26,
          jobs: [
            { id: 'j_fpo1', name: 'MO Assentamento de porcelanato externo', defaultDurationDays: 1 },
            { id: 'j_fpo2', name: 'MO Rejuntamento de porcelanato', defaultDurationDays: 1 },
          ],
        },
        {
          id: 'pkg_fac_molduras',
          name: 'MOLDURAS',
          color: '#4f46e5',
          rhythmText: '1d - 15ml',
          rhythmDays: 1,
          position: 7, colIndex: 27,
          jobs: [
            { id: 'j_fmo1', name: 'MO chumbamento suportes para moldura', defaultDurationDays: 1 },
            { id: 'j_fmo2', name: 'MO colagem de molduras', defaultDurationDays: 1 },
            { id: 'j_fmo3', name: 'MO Impermeabilização e tratamento de juntas', defaultDurationDays: 1 },
          ],
        },
        {
          id: 'pkg_fac_textura',
          name: 'TEXTURA FACHADA',
          color: '#ea580c',
          rhythmText: '1d - por balancim',
          rhythmDays: 1,
          position: 8, colIndex: 28,
          jobs: [
            { id: 'j_ftx1', name: 'MO Aplicação de textura projetada', defaultDurationDays: 1 },
            { id: 'j_ftx2', name: 'MO aplicação de selante em fachada', defaultDurationDays: 1 },
          ],
        },
        {
          id: 'pkg_fac_desm_balancim',
          name: 'DESM. BALANCIM',
          color: '#dc2626',
          rhythmText: '10d',
          rhythmDays: 10,
          position: 9, colIndex: 29,
          jobs: [
            { id: 'j_fdb1', name: 'MO desmontagem de tela de proteção', defaultDurationDays: 4 },
            { id: 'j_fdb2', name: 'MO desmontagem de balancim', defaultDurationDays: 4 },
          ],
        },
        {
          id: 'pkg_fac_fechamento_vaos',
          name: 'FECHAMENTO VÃOS',
          color: '#7c3aed',
          rhythmText: '5d - cada 200m2',
          rhythmDays: 5,
          position: 10, colIndex: 30,
          jobs: [
            { id: 'j_ffv1', name: 'MO montagem de balancim', defaultDurationDays: 1 },
            { id: 'j_ffv2', name: 'MO emboço externo', defaultDurationDays: 2 },
            { id: 'j_ffv3', name: 'MO emboço interno', defaultDurationDays: 2 },
            { id: 'j_ffv4', name: 'MO execução de alvenaria', defaultDurationDays: 2 },
            { id: 'j_ffv5', name: 'MO desmontagem de balancim', defaultDurationDays: 1 },
          ],
        },
        {
          id: 'pkg_fac_esquadrias',
          name: 'ESQUADRIAS',
          color: '#2563eb',
          rhythmText: '1d - por balancim',
          rhythmDays: 1,
          position: 11, colIndex: 31,
          jobs: [
            { id: 'j_feq1', name: 'MO Instalação de esquadrias', defaultDurationDays: 1 },
            { id: 'j_feq2', name: 'MO aplicação de tarucel e selante PU', defaultDurationDays: 1 },
          ],
        },
        {
          id: 'pkg_fac_sacadas',
          name: 'SACADAS',
          color: '#059669',
          rhythmText: '3d - por pvto',
          rhythmDays: 3,
          position: 12, colIndex: 32,
          jobs: [
            { id: 'j_fsc1', name: 'MO Forro de gesso em placa', defaultDurationDays: 1 },
            { id: 'j_fsc2', name: 'MO Impermeabilização com argamassa polimérica', defaultDurationDays: 1 },
            { id: 'j_fsc3', name: 'MO Textura projetada em sacada', defaultDurationDays: 1 },
            { id: 'j_fsc4', name: 'MO revestimento cerâmico de pisos', defaultDurationDays: 1 },
            { id: 'j_fsc5', name: 'MO Assentamento de pingadeiras em granito', defaultDurationDays: 1 },
          ],
        },
        {
          id: 'pkg_fac_serralheria1',
          name: 'SERRALHERIA 1',
          color: '#475569',
          rhythmText: '5d - por face',
          rhythmDays: 5,
          position: 13, colIndex: 33,
          jobs: [
            { id: 'j_fsr1', name: 'MO Instalação de brises em fachada', defaultDurationDays: 3 },
            { id: 'j_fsr2', name: 'MO Instalação de guarda-corpos', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_fac_floreiras2',
          name: 'FLOREIRAS 2',
          color: '#16a34a',
          rhythmText: '5d - por face',
          rhythmDays: 5,
          position: 14, colIndex: 34,
          jobs: [
            { id: 'j_ff2_1', name: 'MO enchimento de floreiras com material para plantio', defaultDurationDays: 3 },
            { id: 'j_ff2_2', name: 'MO Paisagismo de floreiras', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_fac_limpeza',
          name: 'LIMPEZA',
          color: '#10b981',
          rhythmText: '5d - por face',
          rhythmDays: 5,
          position: 15, colIndex: 35,
          jobs: [
            { id: 'j_flm1', name: 'MO Limpeza de fachada com cadeirinha', defaultDurationDays: 5 },
          ],
        },
      ],
    },
    {
      id: 'sw_roof',
      name: 'ÁTICO / COBERTURA',
      category: 'roof',
      color: '#e11d48',
      targetGroupName: 'Ático / Cobertura',
      packages: [
        {
          id: 'pkg_ati_icamento',
          name: 'IÇAMENTO CAIXA D\'AGUA',
          color: '#be123c',
          rhythmText: '10d - por pvto',
          rhythmDays: 10,
          position: 1,
          jobs: [
            { id: 'j_ic1', name: 'SERV Locação de guindaste', defaultDurationDays: 4 },
            { id: 'j_ic2', name: 'MO Içamento de caixas d\'agua', defaultDurationDays: 3 },
            { id: 'j_ic3', name: 'MO contrapiso com caída para impermeabilização', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_ati_regul_pisos',
          name: 'REGULARIZAÇÃO DE PISOS',
          color: '#9f1239',
          rhythmText: '10d - por pvto',
          rhythmDays: 10,
          position: 2, colIndex: 21,
          jobs: [
            { id: 'j_arp1', name: 'MO contrapiso com caída para impermeabilização (ático)', defaultDurationDays: 4 },
            { id: 'j_arp2', name: 'MO regularização de cantos para impermeabilização', defaultDurationDays: 3 },
            { id: 'j_arp3', name: 'MO contrapiso com caída para impermeabilização (cobertura)', defaultDurationDays: 4 },
            { id: 'j_arp4', name: 'MO regularização de cantos (cobertura)', defaultDurationDays: 3 },
            { id: 'j_arp5', name: 'Colocação de manta acústica', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_ati_emboco_ext2',
          name: 'EMBOÇO EXT. 2',
          color: '#881337',
          rhythmText: '10d - cada 200 m2',
          rhythmDays: 10,
          position: 3, colIndex: 23,
          jobs: [
            { id: 'j_aee1', name: 'MO de montagem de andaimes', defaultDurationDays: 2 },
            { id: 'j_aee2', name: 'MO Chapisco externo', defaultDurationDays: 2 },
            { id: 'j_aee3', name: 'MO Emboço externo', defaultDurationDays: 4 },
            { id: 'j_aee4', name: 'MO de desmontagem de andaimes', defaultDurationDays: 1 },
          ],
        },
        {
          id: 'pkg_ati_imperm_cxa',
          name: 'IMPERM. CXA. D´AGUA',
          color: '#0891b2',
          rhythmText: '20d - por pvto',
          rhythmDays: 20,
          position: 4, colIndex: 25,
          jobs: [
            { id: 'j_aic1', name: 'MO Regularização de fundo e paredes de caixa d\'agua', defaultDurationDays: 6 },
            { id: 'j_aic2', name: 'MO Impermeabilização com argamassa polimérica', defaultDurationDays: 7 },
            { id: 'j_aic3', name: 'MO Teste de estanqueidade', defaultDurationDays: 4 },
          ],
        },
        {
          id: 'pkg_ati_imperm_ext2',
          name: 'IMPERM. EXT 2',
          color: '#0284c7',
          rhythmText: '20d - por pvto',
          rhythmDays: 20,
          position: 5, colIndex: 27,
          jobs: [
            { id: 'j_aie1', name: 'MO corte de carangueijos e preenchimento', defaultDurationDays: 4 },
            { id: 'j_aie2', name: 'MO Impermeabilização com manta asfáltica', defaultDurationDays: 6 },
            { id: 'j_aie3', name: 'MO Proteção mecânica', defaultDurationDays: 4 },
            { id: 'j_aie4', name: 'MO Colocação de tela galvanizada sobre manta', defaultDurationDays: 3 },
            { id: 'j_aie5', name: 'MO Emboço externo', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_ati_textura',
          name: 'TEXTURA ÁTICO',
          color: '#d97706',
          rhythmText: '10d - cada 400 m2',
          rhythmDays: 10,
          position: 6, colIndex: 29,
          jobs: [
            { id: 'j_atx1', name: 'MO Aplicação de textura projetada', defaultDurationDays: 6 },
          ],
        },
        {
          id: 'pkg_ati_rufos',
          name: 'RUFOS',
          color: '#64748b',
          rhythmText: '10d - por trecho',
          rhythmDays: 10,
          position: 7, colIndex: 30,
          jobs: [
            { id: 'j_rf1', name: 'MO Colocação de rufos', defaultDurationDays: 6 },
          ],
        },
        {
          id: 'pkg_ati_serralheria2',
          name: 'SERRALHERIA 2',
          color: '#475569',
          rhythmText: '10d - por pvto',
          rhythmDays: 10,
          position: 8, colIndex: 31,
          jobs: [
            { id: 'j_as2_1', name: 'MO Instalação de alçapões', defaultDurationDays: 3 },
            { id: 'j_as2_2', name: 'MO Instalação de escada marinheiro', defaultDurationDays: 4 },
          ],
        },
        {
          id: 'pkg_ati_instalacoes',
          name: 'INSTALAÇÕES ÁTICO',
          color: '#4f46e5',
          rhythmText: '15d - por pvto',
          rhythmDays: 15,
          position: 9, colIndex: 32,
          jobs: [
            { id: 'j_ait1', name: 'MO Instalação de exaustores de churrasqueira', defaultDurationDays: 4 },
            { id: 'j_ait2', name: 'MO Instalação de sistema SPDA', defaultDurationDays: 5 },
            { id: 'j_ait3', name: 'MO Instalação de chaminés de churrasqueira', defaultDurationDays: 4 },
          ],
        },
      ],
    },
    {
      id: 'sw_general',
      name: 'GERAL E CUSTOS',
      category: 'general',
      color: '#475569',
      targetGroupName: 'Geral',
      packages: [
        {
          id: 'pkg_ger_grua',
          name: 'GRUA',
          color: '#334155',
          rhythmText: '5d - por pvto',
          rhythmDays: 5,
          position: 1, colIndex: 9,
          jobs: [
            { id: 'j_gru1', name: 'SERV. Montagem de grua', defaultDurationDays: 5 },
            { id: 'j_gru2', name: 'Operação de grua até fim da estrutura', defaultDurationDays: 60 },
            { id: 'j_gru3', name: 'MO Desmontagem de grua', defaultDurationDays: 5 },
          ],
        },
        {
          id: 'pkg_ger_cremalheira',
          name: 'CREMALHEIRA',
          color: '#1e293b',
          rhythmText: '5d - por pvto',
          rhythmDays: 5,
          position: 2, colIndex: 12,
          jobs: [
            { id: 'j_cre1', name: 'SERV. Montagem de elevador cremalheira', defaultDurationDays: 5 },
            { id: 'j_cre2', name: 'Operação cremalheira até fim da fachada', defaultDurationDays: 90 },
            { id: 'j_cre3', name: 'MO Desmontagem de cremalheira', defaultDurationDays: 5 },
          ],
        },
        {
          id: 'pkg_ger_contramarcos',
          name: 'CONTRAMARCOS',
          color: '#475569',
          rhythmText: '5d - por pvto',
          rhythmDays: 5,
          position: 3, colIndex: 13,
          jobs: [
            { id: 'j_ctm1', name: 'MO Taliscamento de paredes', defaultDurationDays: 3 },
            { id: 'j_ctm2', name: 'MO Instalação de Contramarcos', defaultDurationDays: 4 },
          ],
        },
        {
          id: 'pkg_ger_prumadas',
          name: 'PRUMADAS',
          color: '#0891b2',
          rhythmText: '10d - por prumada',
          rhythmDays: 10,
          position: 4, colIndex: 21,
          jobs: [
            { id: 'j_pru1', name: 'MO Montagem de tubulação de Incêndio', defaultDurationDays: 5 },
            { id: 'j_pru2', name: 'MO Prumadas de elétrica', defaultDurationDays: 5 },
            { id: 'j_pru3', name: 'MO Prumadas de telecom', defaultDurationDays: 4 },
            { id: 'j_pru4', name: 'MO Prumadas de hidráulica', defaultDurationDays: 5 },
          ],
        },
        {
          id: 'pkg_ger_prep_elevador',
          name: 'PREP. PARA ELEVADOR',
          color: '#0284c7',
          rhythmText: '10d',
          rhythmDays: 10,
          position: 5, colIndex: 22,
          jobs: [
            { id: 'j_pel1', name: 'MO Regularização para impermeabilização', defaultDurationDays: 3 },
            { id: 'j_pel2', name: 'MO Impermeabilização com argamassa polimérica', defaultDurationDays: 3 },
            { id: 'j_pel3', name: 'MO Execução de proteção mecânica', defaultDurationDays: 2 },
            { id: 'j_pel4', name: 'MO Pintura de poço de elevador', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_ger_elevador',
          name: 'ELEVADOR INTERNO',
          color: '#4f46e5',
          rhythmText: '30d',
          rhythmDays: 30,
          position: 6, colIndex: 23,
          jobs: [
            { id: 'j_elv1', name: 'SERV Instalação de elevador definitivo', defaultDurationDays: 30 },
          ],
        },
        {
          id: 'pkg_ger_escadas',
          name: 'ESCADAS',
          color: '#7c3aed',
          rhythmText: '10d - por pvto',
          rhythmDays: 10,
          position: 7, colIndex: 24,
          jobs: [
            { id: 'j_esc1', name: 'MO contrapiso escadas', defaultDurationDays: 4 },
            { id: 'j_esc2', name: 'MO corrimão escadarias', defaultDurationDays: 3 },
            { id: 'j_esc3', name: 'MO Pintura de piso de escadas', defaultDurationDays: 3 },
            { id: 'j_esc4', name: 'MO Textura rolada nas escadas', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_ger_quadros',
          name: 'QUADROS E ABRIGOS',
          color: '#d97706',
          rhythmText: '15d - por ocorrência',
          rhythmDays: 15,
          position: 8, colIndex: 25,
          jobs: [
            { id: 'j_qdr1', name: 'MO Montagem dos quadros de medição', defaultDurationDays: 5 },
            { id: 'j_qdr2', name: 'MO Montagem dos quadros de telefonia', defaultDurationDays: 4 },
            { id: 'j_qdr3', name: 'MO Montagem dos QDG', defaultDurationDays: 5 },
            { id: 'j_qdr4', name: 'MO Firestop em shafts', defaultDurationDays: 3 },
            { id: 'j_qdr5', name: 'MO Montagem de caixas de Incêndio', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_ger_portas_cf',
          name: 'PORTAS CORTA FOGO',
          color: '#dc2626',
          rhythmText: '10d - por pvto',
          rhythmDays: 10,
          position: 9, colIndex: 26,
          jobs: [
            { id: 'j_pcf1', name: 'MO Instalação de portas corta-fogo', defaultDurationDays: 4 },
            { id: 'j_pcf2', name: 'MO Fechamento de shafts corredor', defaultDurationDays: 3 },
            { id: 'j_pcf3', name: 'MO Forro shafts corredor', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_ger_desmobilizacao',
          name: 'DESMOBILIZAÇÃO',
          color: '#b91c1c',
          rhythmText: '15d',
          rhythmDays: 15,
          position: 10, colIndex: 28,
          jobs: [
            { id: 'j_dsm1', name: 'MO Desmontagem de barracões externos', defaultDurationDays: 5 },
            { id: 'j_dsm2', name: 'MO Montagem de barracão interno', defaultDurationDays: 4 },
            { id: 'j_dsm3', name: 'SERV Locação de container', defaultDurationDays: 3 },
          ],
        },
        {
          id: 'pkg_ger_corredores',
          name: 'CORREDORES',
          color: '#a21caf',
          rhythmText: '10d - por pvto',
          rhythmDays: 10,
          position: 11, colIndex: 29,
          jobs: [
            { id: 'j_cor1', name: 'MO forro gesso em placa', defaultDurationDays: 4 },
            { id: 'j_cor2', name: 'MO tabicas para forro de gesso', defaultDurationDays: 3 },
            { id: 'j_cor3', name: 'MO Rodapés em revestimento cerâmico', defaultDurationDays: 3 },
            { id: 'j_cor4', name: 'MO revestimento cerâmico piso', defaultDurationDays: 4 },
            { id: 'j_cor5', name: 'MO fechamento shafts', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_ger_bombas',
          name: 'BOMBAS E INST ESPECIAIS',
          color: '#047857',
          rhythmText: '10d',
          rhythmDays: 10,
          position: 12, colIndex: 31,
          jobs: [
            { id: 'j_bmb1', name: 'MO Instalação de bombas de recalque', defaultDurationDays: 3 },
            { id: 'j_bmb2', name: 'MO Instalação de bombas de piscina', defaultDurationDays: 3 },
            { id: 'j_bmb3', name: 'MO Instalação de bombas de águas pluviais', defaultDurationDays: 3 },
            { id: 'j_bmb4', name: 'MO Instalação de pressurizadores', defaultDurationDays: 2 },
          ],
        },
        {
          id: 'pkg_ger_cftv',
          name: 'CFTV E AUTOMAÇÃO',
          color: '#1e3a8a',
          rhythmText: '10d',
          rhythmDays: 10,
          position: 13, colIndex: 34,
          jobs: [
            { id: 'j_cft1', name: 'MO Instalação de câmeras', defaultDurationDays: 3 },
            { id: 'j_cft2', name: 'MO Instalação de porteiro eletrônico', defaultDurationDays: 2 },
            { id: 'j_cft3', name: 'MO Instalação de rede de interfonia', defaultDurationDays: 3 },
            { id: 'j_cft4', name: 'MO Instalação de portão automatizado', defaultDurationDays: 2 },
          ],
        },
      ],
    },
  ];

  // =========================================================================
  // VÍNCULOS INTER-RAIAS DE EXEMPLO (O DIFERENCIAL DE ENGENHARIA!)
  // =========================================================================
  const interLinks: InterSwimlaneLink[] = [
    // 1. A Torre só começa após o Subsolo concluir a Supraestrutura
    {
      id: 'lnk_sub_to_torre',
      sourceSwimlaneId: 'sw_basement',
      sourcePackageId: 'pkg_sub_supra',
      targetSwimlaneId: 'sw_tower',
      targetPackageId: 'pkg_torre_estrutura',
      type: 'finish_to_start',
      lagValue: 0,
      description: 'Estrutura da Torre inicia após Supraestrutura dos Subsolos',
    },
    // 2. A Fachada inicia quando a Estrutura da Torre atinge 5 pavimentos de avanço
    {
      id: 'lnk_torre_to_fachada',
      sourceSwimlaneId: 'sw_tower',
      sourcePackageId: 'pkg_torre_estrutura',
      targetSwimlaneId: 'sw_facade',
      targetPackageId: 'pkg_fac_balancim',
      type: 'floor_lag',
      lagValue: 5,
      description: 'Balancim da Fachada liberado após 5 pavimentos de Estrutura da Torre',
    },
    // 3. O Ático/Cobertura inicia após a Estrutura da Torre concluir
    {
      id: 'lnk_torre_to_roof',
      sourceSwimlaneId: 'sw_tower',
      sourcePackageId: 'pkg_torre_estrutura',
      targetSwimlaneId: 'sw_roof',
      targetPackageId: 'pkg_ati_icamento',
      type: 'finish_to_start',
      lagValue: 0,
      description: 'Içamento Caixa d\'água após término de Estrutura da Torre',
    },
    // 4. Conclusão da Estrutura dispara Marco "TÉRMINO ESTRUTURA"
    {
      id: 'lnk_torre_to_marco_est',
      sourceSwimlaneId: 'sw_tower',
      sourcePackageId: 'pkg_torre_estrutura',
      targetSwimlaneId: 'sw_milestones',
      targetPackageId: 'm_term_estrutura',
      type: 'finish_to_start',
      lagValue: 0,
      description: 'Dispara Marco Oficial de Término de Estrutura',
    },
    // 5. Conclusão da Alvenaria dispara Marco "TÉRMINO ALVENARIA"
    {
      id: 'lnk_torre_to_marco_alv',
      sourceSwimlaneId: 'sw_tower',
      sourcePackageId: 'pkg_torre_alvenaria',
      targetSwimlaneId: 'sw_milestones',
      targetPackageId: 'm_term_alvenaria',
      type: 'finish_to_start',
      lagValue: 0,
      description: 'Dispara Marco Oficial de Término de Alvenaria',
    },
    // 6. Conclusão da Fachada dispara Marco "TÉRMINO FACHADA"
    {
      id: 'lnk_facada_to_marco_fac',
      sourceSwimlaneId: 'sw_facade',
      sourcePackageId: 'pkg_fac_limpeza',
      targetSwimlaneId: 'sw_milestones',
      targetPackageId: 'm_term_fachada',
      type: 'finish_to_start',
      lagValue: 0,
      description: 'Dispara Marco Oficial de Término de Fachada',
    },
  ];

  return {
    version: '1.0',
    updatedAt: new Date().toISOString(),
    swimlanes,
    interLinks,
  };
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
      interLinks: interLinks.length > 0 ? interLinks : getDefaultMacroflowModel().interLinks,
    };
  }

  // Fallback para o modelo padrão se o arquivo estava em branco
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
        costWeight: 1000,
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
        defaultTotalCost: 10000,
        autoChainJobs: true,
        jobs: jobs.length > 0 ? jobs : [
          {
            id: `tpl_${slugifySchedule(pkg.name)}_1`,
            name: pkg.name,
            position: 1,
            defaultDuration: pkg.rhythmDays || 5,
            defaultResponsible: 'EQUIPE GERAL',
            costWeight: 10000,
          },
        ],
      };

      services.push(sPkg);
      serviceByPkgId.set(pkg.id, sPkg);
    });
  });

  // 3. Garante que os pavimentos existam para cada grupo (se a obra estiver vazia, gera lote inicial)
  let floors = [...currentState.floors];
  if (floors.length === 0) {
    existingGroups.forEach((grp) => {
      const qty = grp.name.toLowerCase().includes('subsolo') ? 3 : grp.name.toLowerCase().includes('torre') ? 15 : 1;
      for (let i = 1; i <= qty; i++) {
        const numStr = i < 10 ? `0${i}` : `${i}`;
        const name = grp.name.toLowerCase().includes('subsolo')
          ? `Subsolo ${numStr}`
          : grp.name.toLowerCase().includes('torre')
          ? `Pavimento ${numStr}`
          : grp.name;
        floors.push({
          id: `flr_${slugifySchedule(name)}_${i}`,
          name,
          position: floors.length + 1,
          replicationGroupId: grp.id,
        });
      }
    });
  }

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

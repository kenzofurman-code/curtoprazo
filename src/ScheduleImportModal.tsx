import React, { useState, useMemo, useEffect } from 'react';
import {
  analyzeWorkbook,
  detectColumns,
  processScheduleData,
  CRONOGRAMA_FIELD_DEFS,
  type WorkbookAnalysis,
  type ColumnDetectionResult,
  type ParsedCronogramaResult,
} from './scheduleImportEngine';
import {
  type ScheduleVersionType,
  type ScheduleVersionSnapshot,
} from './scheduleVersions';

interface ScheduleImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  projectName?: string;
  currentSnapshot?: ScheduleVersionSnapshot;
  onImportComplete: (
    parsedResult: ParsedCronogramaResult,
    versionMeta: {
      name: string;
      description: string;
      type: ScheduleVersionType;
      author: string;
      referenceDate: string;
      sourceFileName: string;
      isBaseline: boolean;
      makeActive: boolean;
    }
  ) => Promise<void>;
}

export const ScheduleImportModal: React.FC<ScheduleImportModalProps> = ({
  isOpen,
  onClose,
  projectId,
  projectName = 'Obra',
  currentSnapshot,
  onImportComplete,
}) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileBuffer, setFileBuffer] = useState<ArrayBuffer | null>(null);
  const [analysis, setAnalysis] = useState<WorkbookAnalysis | null>(null);

  // Passo 1: Configuração das linhas
  const [selectedSheet, setSelectedSheet] = useState<string>('');
  const [headerRowDisplay, setHeaderRowDisplay] = useState<number>(4); // 1-based para o usuário
  const [dataStartRowDisplay, setDataStartRowDisplay] = useState<number>(5); // 1-based para o usuário

  // Passo 2: Mapeamento de colunas
  const [detectionResult, setDetectionResult] = useState<ColumnDetectionResult | null>(null);
  const [userFieldMapping, setUserFieldMapping] = useState<Record<string, number>>({});

  // Passo 3: Metadados da versão e rastreabilidade
  const [versionName, setVersionName] = useState<string>('');
  const [versionType, setVersionType] = useState<ScheduleVersionType>('forecast');
  const [referenceDate, setReferenceDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [description, setDescription] = useState<string>('');
  const [author, setAuthor] = useState<string>('Engenharia de Planejamento');
  const [isBaseline, setIsBaseline] = useState<boolean>(false);
  const [makeActive, setMakeActive] = useState<boolean>(true);

  // Estados de execução
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [processStatus, setProcessStatus] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');

  // Reseta ao fechar/abrir
  useEffect(() => {
    if (!isOpen) {
      setStep(1);
      setSelectedFile(null);
      setFileBuffer(null);
      setAnalysis(null);
      setDetectionResult(null);
      setUserFieldMapping({});
      setErrorMessage('');
      setIsProcessing(false);
    }
  }, [isOpen]);

  // Ao selecionar um arquivo
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    loadFileInput(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    loadFileInput(file);
  };

  const loadFileInput = (file: File) => {
    setErrorMessage('');
    setSelectedFile(file);
    setIsProcessing(true);
    setProcessStatus('Lendo estrutura do arquivo...');

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const buffer = evt.target?.result as ArrayBuffer;
        setFileBuffer(buffer);
        const analyzed = analyzeWorkbook(buffer);
        setAnalysis(analyzed);
        setSelectedSheet(analyzed.currentSheet);

        // Preenche sugestões baseadas na análise automática
        const header1Based = analyzed.suggestedHeaderRow + 1;
        const dataStart1Based = analyzed.suggestedDataStartRow + 1;
        setHeaderRowDisplay(header1Based);
        setDataStartRowDisplay(dataStart1Based);

        // Gera sugestão de nome de versão e data
        const cleanBaseName = file.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ');
        setVersionName(`Importação ${cleanBaseName}`);
        if (analyzed.detectedDateMetadata) {
          setReferenceDate(analyzed.detectedDateMetadata);
        }

        // Executa a detecção preliminar de colunas
        const detection = detectColumns(
          analyzed.rawRows,
          analyzed.suggestedHeaderRow,
          analyzed.suggestedDataStartRow
        );
        setDetectionResult(detection);
        setUserFieldMapping(detection.matchedFieldIndices);

        setIsProcessing(false);
      } catch (err: any) {
        console.error('Erro ao ler planilha:', err);
        setErrorMessage(`Falha ao ler arquivo: ${err?.message || 'Formato inválido ou corrompido'}`);
        setIsProcessing(false);
      }
    };
    reader.onerror = () => {
      setErrorMessage('Erro ao carregar o arquivo.');
      setIsProcessing(false);
    };
    reader.readAsArrayBuffer(file);
  };

  // Troca de aba da planilha
  const handleSheetChange = (newSheet: string) => {
    if (!fileBuffer) return;
    setSelectedSheet(newSheet);
    try {
      const analyzed = analyzeWorkbook(fileBuffer, newSheet);
      setAnalysis(analyzed);
      const header1Based = analyzed.suggestedHeaderRow + 1;
      const dataStart1Based = analyzed.suggestedDataStartRow + 1;
      setHeaderRowDisplay(header1Based);
      setDataStartRowDisplay(dataStart1Based);

      const detection = detectColumns(analyzed.rawRows, analyzed.suggestedHeaderRow, analyzed.suggestedDataStartRow);
      setDetectionResult(detection);
      setUserFieldMapping(detection.matchedFieldIndices);
    } catch (err: any) {
      setErrorMessage(`Erro ao ler aba "${newSheet}": ${err?.message}`);
    }
  };

  // Atualização das linhas de cabeçalho ou dados configuradas pelo usuário
  const handleUpdateRows = (newHeader1Based: number, newDataStart1Based: number) => {
    if (!analysis) return;
    setHeaderRowDisplay(newHeader1Based);
    setDataStartRowDisplay(newDataStart1Based);

    const headerIdx = Math.max(0, newHeader1Based - 1);
    const dataStartIdx = Math.max(headerIdx + 1, newDataStart1Based - 1);

    const detection = detectColumns(analysis.rawRows, headerIdx, dataStartIdx);
    setDetectionResult(detection);
    setUserFieldMapping(detection.matchedFieldIndices);
  };

  // Mapeamento manual de um campo específico
  const handleFieldColChange = (fieldKey: string, colIndex: number) => {
    setUserFieldMapping((prev) => ({
      ...prev,
      [fieldKey]: colIndex,
    }));
  };

  // Validação do Passo 2 (Mapeamento de colunas)
  const validationSummary = useMemo(() => {
    const requiredFields = CRONOGRAMA_FIELD_DEFS.filter((f) => f.required);
    const missingRequired = requiredFields.filter((f) => {
      const idx = userFieldMapping[f.key];
      return idx === undefined || idx === -1;
    });

    const mappedCount = Object.values(userFieldMapping).filter((v) => v !== undefined && v !== -1).length;

    return {
      isValid: missingRequired.length === 0,
      missingRequired,
      mappedCount,
      totalFields: CRONOGRAMA_FIELD_DEFS.length,
    };
  }, [userFieldMapping]);

  // Execução final da importação
  const handleExecuteImport = async () => {
    if (!analysis || !fileBuffer) return;

    try {
      setIsProcessing(true);
      setProcessStatus('Processando e estruturando atividades do cronograma...');
      setErrorMessage('');

      // Espera um ciclo de render para exibir status
      await new Promise((resolve) => setTimeout(resolve, 50));

      const dataStartIdx = Math.max(0, dataStartRowDisplay - 1);
      const parsed = processScheduleData(
        analysis.rawRows,
        dataStartIdx,
        userFieldMapping,
        {
          teams: currentSnapshot?.teams,
          floors: currentSnapshot?.floors,
          matrices: currentSnapshot?.matrices,
          weights: currentSnapshot?.weights,
          allFloorsData: currentSnapshot?.allFloorsData,
        }
      );

      if (parsed.parsedItems.length === 0) {
        throw new Error('Nenhuma atividade pôde ser gerada a partir dos dados da planilha.');
      }

      setProcessStatus(`Salvando nova versão com ${parsed.stats.totalActivities.toLocaleString('pt-BR')} itens...`);
      await onImportComplete(parsed, {
        name: versionName.trim() || `Cronograma ${selectedFile?.name || 'Importado'}`,
        description: description.trim() || `Importado a partir do arquivo "${selectedFile?.name || ''}".`,
        type: versionType,
        author: author.trim() || 'Usuário Atual',
        referenceDate: referenceDate || new Date().toISOString().split('T')[0],
        sourceFileName: selectedFile?.name || 'arquivo.xlsx',
        isBaseline,
        makeActive,
      });

      setIsProcessing(false);
      onClose();
    } catch (err: any) {
      console.error('Erro na importação:', err);
      setErrorMessage(`Erro ao importar cronograma: ${err?.message || 'Erro inesperado'}`);
      setIsProcessing(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-5 animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-4xl overflow-hidden flex flex-col max-h-[94vh]">
        {/* CABEÇALHO DO MODAL */}
        <div className="p-4 sm:p-5 bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white flex justify-between items-center shrink-0 border-b border-indigo-900/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-400/30 flex items-center justify-center text-xl shrink-0">
              📥
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base sm:text-lg font-black uppercase tracking-wider text-white">
                  Motor Inteligente de Importação de Cronograma
                </h3>
                <span className="bg-indigo-500/30 text-indigo-200 text-[10px] font-black px-2 py-0.5 rounded-full border border-indigo-400/30 uppercase">
                  XLSX / CSV
                </span>
              </div>
              <p className="text-xs text-slate-300">
                Detecção semântica de colunas, parametrização de linhas e histórico com rastreabilidade
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isProcessing}
            className="text-slate-400 hover:text-white p-2 rounded-xl hover:bg-white/10 transition text-lg leading-none cursor-pointer disabled:opacity-30"
          >
            ✕
          </button>
        </div>

        {/* INDICADOR DE PASSOS (STEPPER) */}
        <div className="bg-slate-50 border-b border-slate-200 px-6 py-2.5 flex items-center justify-between text-xs shrink-0 select-none">
          <div className="flex items-center gap-2 sm:gap-6 w-full">
            {/* Passo 1 */}
            <div
              className={`flex items-center gap-2 ${
                step === 1 ? 'text-indigo-700 font-black' : step > 1 ? 'text-emerald-700 font-bold' : 'text-slate-400'
              }`}
            >
              <span
                className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-black ${
                  step === 1
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : step > 1
                    ? 'bg-emerald-600 text-white'
                    : 'bg-slate-200 text-slate-600'
                }`}
              >
                {step > 1 ? '✓' : '1'}
              </span>
              <span className="hidden sm:inline">1. Planilha & Linhas</span>
            </div>

            <div className={`h-0.5 flex-1 ${step > 1 ? 'bg-emerald-400' : 'bg-slate-200'}`} />

            {/* Passo 2 */}
            <div
              className={`flex items-center gap-2 ${
                step === 2 ? 'text-indigo-700 font-black' : step > 2 ? 'text-emerald-700 font-bold' : 'text-slate-400'
              }`}
            >
              <span
                className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-black ${
                  step === 2
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : step > 2
                    ? 'bg-emerald-600 text-white'
                    : 'bg-slate-200 text-slate-600'
                }`}
              >
                {step > 2 ? '✓' : '2'}
              </span>
              <span className="hidden sm:inline">2. Mapeamento de Colunas</span>
            </div>

            <div className={`h-0.5 flex-1 ${step > 2 ? 'bg-emerald-400' : 'bg-slate-200'}`} />

            {/* Passo 3 */}
            <div
              className={`flex items-center gap-2 ${
                step === 3 ? 'text-indigo-700 font-black' : 'text-slate-400'
              }`}
            >
              <span
                className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-black ${
                  step === 3 ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-200 text-slate-600'
                }`}
              >
                3
              </span>
              <span className="hidden sm:inline">3. Rastreabilidade & Versão</span>
            </div>
          </div>
        </div>

        {/* FEEDBACK DE ERRO */}
        {errorMessage && (
          <div className="p-3 mx-6 mt-4 bg-rose-50 border border-rose-200 rounded-xl text-rose-800 text-xs flex items-center gap-2 animate-in fade-in">
            <span className="text-base shrink-0">⚠️</span>
            <div className="flex-1 font-semibold">{errorMessage}</div>
          </div>
        )}

        {/* CORPO DO MODAL (CONTEÚDO ROLÁVEL) */}
        <div className="p-5 sm:p-6 overflow-y-auto flex-1 space-y-5">
          {/* =========================================================================
              PASSO 1: UPLOAD DO ARQUIVO E ESTRUTURA DE LINHAS (CABEÇALHO & DADOS)
             ========================================================================= */}
          {step === 1 && (
            <div className="space-y-5 animate-in fade-in duration-200">
              {!selectedFile ? (
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleDrop}
                  className="border-2 border-dashed border-indigo-200 hover:border-indigo-500 rounded-2xl p-10 bg-indigo-50/30 hover:bg-indigo-50/60 transition flex flex-col items-center justify-center text-center cursor-pointer relative group"
                >
                  <input
                    type="file"
                    accept=".xlsx, .xls, .csv"
                    onChange={handleFileChange}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  />
                  <div className="w-16 h-16 rounded-2xl bg-indigo-100 group-hover:scale-110 group-hover:bg-indigo-200 transition-all flex items-center justify-center text-3xl mb-3 shadow-inner">
                    📊
                  </div>
                  <h4 className="text-base font-black text-indigo-950 uppercase tracking-tight mb-1">
                    Selecione ou arraste a planilha de cronograma
                  </h4>
                  <p className="text-xs text-slate-500 max-w-md">
                    Formatos suportados: <strong className="text-slate-700">.xlsx, .xls, .csv</strong> (Prevision, MS Project, Sienge, Primavera ou Excel padrão)
                  </p>
                  <span className="mt-4 px-4 py-2 bg-indigo-600 group-hover:bg-indigo-700 text-white rounded-xl text-xs font-black uppercase tracking-wider shadow-sm transition">
                    Escolher Arquivo do Computador
                  </span>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Card do arquivo carregado */}
                  <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="text-3xl">📄</span>
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-black text-slate-800">{selectedFile.name}</h4>
                          <span className="text-[10px] bg-slate-200 text-slate-700 font-bold px-2 py-0.5 rounded-full">
                            {(selectedFile.size / 1024).toFixed(1)} KB
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">
                          Total de linhas brutas: <strong className="text-slate-700">{analysis?.totalRows.toLocaleString('pt-BR') || 0}</strong>
                          {analysis?.detectedProjectTitle ? ` • ${analysis.detectedProjectTitle}` : ''}
                        </p>
                      </div>
                    </div>
                    <label className="cursor-pointer text-xs font-black text-indigo-600 hover:text-indigo-800 underline">
                      Trocar arquivo
                      <input type="file" accept=".xlsx, .xls, .csv" onChange={handleFileChange} className="hidden" />
                    </label>
                  </div>

                  {/* Se houver múltiplas abas */}
                  {analysis && analysis.sheetNames.length > 1 && (
                    <div className="bg-indigo-50/50 border border-indigo-200 rounded-xl p-3 flex items-center justify-between">
                      <span className="text-xs font-bold text-indigo-900">
                        Aba (Sheet) da Planilha a Importar:
                      </span>
                      <select
                        value={selectedSheet}
                        onChange={(e) => handleSheetChange(e.target.value)}
                        className="bg-white border border-indigo-300 rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-800"
                      >
                        {analysis.sheetNames.map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Parâmetros solicitados pelo usuário: Linha de Cabeçalho e Linha dos Dados */}
                  <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs space-y-3">
                    <div className="border-b border-slate-100 pb-2">
                      <h5 className="text-xs font-black text-slate-800 uppercase tracking-wider flex items-center gap-1.5">
                        <span>🔍</span> Configuração das Linhas da Planilha
                      </h5>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        O motor sugeriu as linhas abaixo analisando o conteúdo. Ajuste se necessário para o seu arquivo:
                      </p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
                        <label className="block text-[11px] font-black text-slate-700 uppercase tracking-tight mb-1">
                          Linha do Cabeçalho das Colunas:
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={1}
                            max={Math.min(50, analysis?.totalRows || 50)}
                            value={headerRowDisplay}
                            onChange={(e) => {
                              const val = parseInt(e.target.value, 10) || 1;
                              handleUpdateRows(val, dataStartRowDisplay);
                            }}
                            className="w-20 bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800 focus:outline-indigo-500"
                          />
                          <span className="text-[11px] text-slate-500">
                            (Linha no Excel onde estão os títulos das colunas)
                          </span>
                        </div>
                      </div>

                      <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
                        <label className="block text-[11px] font-black text-slate-700 uppercase tracking-tight mb-1">
                          Linha em que começam os Dados:
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={headerRowDisplay + 1}
                            max={Math.min(100, analysis?.totalRows || 100)}
                            value={dataStartRowDisplay}
                            onChange={(e) => {
                              const val = parseInt(e.target.value, 10) || headerRowDisplay + 1;
                              handleUpdateRows(headerRowDisplay, val);
                            }}
                            className="w-20 bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-bold text-slate-800 focus:outline-indigo-500"
                          />
                          <span className="text-[11px] text-slate-500">
                            (Primeira linha com tarefas/serviços reais)
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Prévia interativa das primeiras linhas para validação visual */}
                  {analysis && (
                    <div className="border border-slate-200 rounded-2xl overflow-hidden shadow-xs">
                      <div className="bg-slate-100 px-4 py-2 flex items-center justify-between border-b border-slate-200">
                        <span className="text-xs font-black text-slate-700 uppercase tracking-tight">
                          Visualização Prévia do Arquivo Bruto
                        </span>
                        <div className="flex items-center gap-3 text-[10px] font-bold">
                          <span className="flex items-center gap-1">
                            <span className="w-2.5 h-2.5 rounded-full bg-indigo-600 inline-block" />
                            Linha Cabeçalho ({headerRowDisplay})
                          </span>
                          <span className="flex items-center gap-1">
                            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" />
                            Início dos Dados ({dataStartRowDisplay})
                          </span>
                        </div>
                      </div>
                      <div className="overflow-x-auto max-h-60 bg-white text-[11px]">
                        <table className="w-full border-collapse">
                          <tbody>
                            {analysis.rawRows.slice(0, Math.max(8, dataStartRowDisplay + 2)).map((row, rIdx) => {
                              const rowNumber = rIdx + 1;
                              const isHeader = rowNumber === headerRowDisplay;
                              const isDataStart = rowNumber === dataStartRowDisplay;
                              return (
                                <tr
                                  key={rIdx}
                                  className={`border-b border-slate-100 ${
                                    isHeader
                                      ? 'bg-indigo-100 font-black text-indigo-950'
                                      : isDataStart
                                      ? 'bg-emerald-50 font-semibold text-emerald-950'
                                      : 'hover:bg-slate-50 text-slate-700'
                                  }`}
                                >
                                  <td className="p-1.5 pl-3 text-[10px] font-mono font-bold text-slate-400 bg-slate-50 w-12 border-r border-slate-200 select-none">
                                    L{rowNumber}
                                  </td>
                                  {(row || []).slice(0, 10).map((cell, cIdx) => (
                                    <td key={cIdx} className="p-1.5 px-2 border-r border-slate-100 truncate max-w-[160px]">
                                      {cell !== undefined && cell !== null && cell !== '' ? String(cell) : '-'}
                                    </td>
                                  ))}
                                  {row && row.length > 10 && (
                                    <td className="p-1.5 px-2 text-slate-400 italic text-[10px]">
                                      +{row.length - 10} colunas...
                                    </td>
                                  )}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* =========================================================================
              PASSO 2: MAPEAMENTO INTELIGENTE DE COLUNAS & TRAZ O QUE NÃO ENCONTRAR
             ========================================================================= */}
          {step === 2 && detectionResult && (
            <div className="space-y-5 animate-in fade-in duration-200">
              {/* Card de Diagnóstico do Motor */}
              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                <div>
                  <h4 className="text-xs font-black text-slate-800 uppercase tracking-tight flex items-center gap-2">
                    <span>⚙️</span> Diagnóstico do Mapeamento de Colunas
                  </h4>
                  <p className="text-xs text-slate-500 mt-0.5">
                    O motor examinou a linha {headerRowDisplay} e identificou automaticamente as colunas abaixo.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="px-2.5 py-1 bg-emerald-100 text-emerald-800 rounded-lg text-xs font-black">
                    ✓ {detectionResult.foundFields.length} identificadas
                  </span>
                  {detectionResult.unmatchedRequiredFields.length > 0 && (
                    <span className="px-2.5 py-1 bg-rose-100 text-rose-800 rounded-lg text-xs font-black animate-pulse">
                      ⚠️ {detectionResult.unmatchedRequiredFields.length} obrigatórias pendentes
                    </span>
                  )}
                  {detectionResult.unmatchedOptionalFields.length > 0 && (
                    <span className="px-2.5 py-1 bg-amber-50 text-amber-700 border border-amber-200 rounded-lg text-xs font-bold">
                      ℹ️ {detectionResult.unmatchedOptionalFields.length} complementares não encontradas
                    </span>
                  )}
                </div>
              </div>

              {/* Seção 1: Campos Obrigatórios */}
              <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs space-y-3">
                <div className="border-b border-slate-100 pb-2 flex justify-between items-center">
                  <h5 className="text-xs font-black text-indigo-900 uppercase tracking-wider flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-rose-500" />
                    Campos Essenciais do Cronograma (Obrigatórios)
                  </h5>
                  <span className="text-[10px] text-slate-400">Todos precisam estar mapeados</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                  {CRONOGRAMA_FIELD_DEFS.filter((f) => f.required).map((field) => {
                    const currentIdx = userFieldMapping[field.key];
                    const isMapped = currentIdx !== undefined && currentIdx !== -1;
                    const selectedCol = isMapped ? detectionResult.columns[currentIdx] : null;

                    return (
                      <div
                        key={field.key}
                        className={`p-3 rounded-xl border transition-all ${
                          isMapped
                            ? 'bg-slate-50/70 border-slate-200'
                            : 'bg-rose-50/50 border-rose-300 shadow-xs'
                        }`}
                      >
                        <div className="flex justify-between items-start mb-1.5">
                          <div>
                            <span className="text-xs font-black text-slate-800 block">
                              {field.label}
                            </span>
                            <span className="text-[10px] text-slate-500 block leading-tight">
                              {field.description}
                            </span>
                          </div>
                          {isMapped ? (
                            <span className="bg-emerald-100 text-emerald-800 text-[10px] font-black px-2 py-0.5 rounded-md shrink-0">
                              ✓ Mapeada
                            </span>
                          ) : (
                            <span className="bg-rose-100 text-rose-800 text-[10px] font-black px-2 py-0.5 rounded-md shrink-0">
                              ⚠️ Selecione
                            </span>
                          )}
                        </div>

                        {/* Dropdown de Colunas da Planilha */}
                        <select
                          value={currentIdx !== undefined ? currentIdx : -1}
                          onChange={(e) => handleFieldColChange(field.key, parseInt(e.target.value, 10))}
                          className={`w-full text-xs font-bold rounded-lg p-2 border ${
                            isMapped
                              ? 'bg-white border-slate-300 text-slate-800 focus:border-indigo-500'
                              : 'bg-white border-rose-400 text-rose-900 focus:border-rose-600'
                          }`}
                        >
                          <option value={-1}>-- Selecione a Coluna da Planilha --</option>
                          {detectionResult.columns.map((col) => (
                            <option key={col.index} value={col.index}>
                              Coluna {col.letter}: {col.name} {col.groupName ? `(${col.groupName})` : ''}
                            </option>
                          ))}
                        </select>

                        {/* Amostra dos dados ao vivo */}
                        {selectedCol && selectedCol.sampleValues.length > 0 && (
                          <div className="mt-1.5 text-[10px] text-slate-500 truncate">
                            <span className="font-semibold text-slate-700">Amostra: </span>
                            {selectedCol.sampleValues.slice(0, 3).map((v) => String(v)).join(' • ')}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Seção 2: Campos Opcionais / Complementares */}
              <div className="bg-white border border-slate-200 rounded-2xl p-4 shadow-xs space-y-3">
                <div className="border-b border-slate-100 pb-2 flex justify-between items-center">
                  <h5 className="text-xs font-black text-indigo-900 uppercase tracking-wider flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-indigo-500" />
                    Campos Complementares (Opcionais & Avançados)
                  </h5>
                  <span className="text-[10px] text-slate-400">
                    O motor traz o que não encontrar para você associar se existir
                  </span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                  {CRONOGRAMA_FIELD_DEFS.filter((f) => !f.required).map((field) => {
                    const currentIdx = userFieldMapping[field.key];
                    const isMapped = currentIdx !== undefined && currentIdx !== -1;
                    const selectedCol = isMapped ? detectionResult.columns[currentIdx] : null;

                    return (
                      <div
                        key={field.key}
                        className={`p-3 rounded-xl border transition-all ${
                          isMapped ? 'bg-slate-50/70 border-slate-200' : 'bg-white border-dashed border-slate-200'
                        }`}
                      >
                        <div className="flex justify-between items-start mb-1.5">
                          <div>
                            <span className="text-xs font-bold text-slate-800 block">
                              {field.label}
                            </span>
                            <span className="text-[10px] text-slate-500 block leading-tight">
                              {field.description}
                            </span>
                          </div>
                          {isMapped ? (
                            <span className="bg-indigo-100 text-indigo-800 text-[10px] font-black px-2 py-0.5 rounded-md shrink-0">
                              ✓ Mapeada
                            </span>
                          ) : (
                            <span className="bg-slate-100 text-slate-500 text-[10px] font-semibold px-2 py-0.5 rounded-md shrink-0">
                              Não mapeada
                            </span>
                          )}
                        </div>

                        {/* Dropdown de Colunas da Planilha */}
                        <select
                          value={currentIdx !== undefined ? currentIdx : -1}
                          onChange={(e) => handleFieldColChange(field.key, parseInt(e.target.value, 10))}
                          className="w-full text-xs font-medium rounded-lg p-2 border bg-white border-slate-300 text-slate-800 focus:border-indigo-500"
                        >
                          <option value={-1}>-- Não mapear / Deixar padrão --</option>
                          {detectionResult.columns.map((col) => (
                            <option key={col.index} value={col.index}>
                              Coluna {col.letter}: {col.name} {col.groupName ? `(${col.groupName})` : ''}
                            </option>
                          ))}
                        </select>

                        {/* Amostra dos dados ao vivo */}
                        {selectedCol && selectedCol.sampleValues.length > 0 && (
                          <div className="mt-1.5 text-[10px] text-slate-500 truncate">
                            <span className="font-semibold text-slate-700">Amostra: </span>
                            {selectedCol.sampleValues.slice(0, 3).map((v) => String(v)).join(' • ')}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* =========================================================================
              PASSO 3: RASTREABILIDADE, INFORMAÇÕES DA IMPORTAÇÃO E METADADOS
             ========================================================================= */}
          {step === 3 && (
            <div className="space-y-5 animate-in fade-in duration-200">
              <div className="bg-indigo-50/40 border border-indigo-200 rounded-2xl p-4">
                <h4 className="text-xs font-black text-indigo-950 uppercase tracking-tight flex items-center gap-1.5">
                  <span>🏷️</span> Rastreabilidade da Importação e Gestão de Versões
                </h4>
                <p className="text-xs text-slate-600 mt-1">
                  Preencha as informações desta versão para que qualquer membro da equipe saiba com exatidão qual foi a fonte, a data e a justificativa deste cronograma no futuro.
                </p>
              </div>

              <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-xs space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-black text-slate-800 uppercase tracking-tight mb-1">
                      Nome da Versão: *
                    </label>
                    <input
                      type="text"
                      value={versionName}
                      onChange={(e) => setVersionName(e.target.value)}
                      placeholder="Ex: Cronograma Executivo QOYA - Rev 02"
                      className="w-full bg-white border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold text-slate-800 focus:outline-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-black text-slate-800 uppercase tracking-tight mb-1">
                      Data de Referência do Cronograma: *
                    </label>
                    <input
                      type="date"
                      value={referenceDate}
                      onChange={(e) => setReferenceDate(e.target.value)}
                      className="w-full bg-white border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold text-slate-800 focus:outline-indigo-500"
                    />
                    <span className="text-[10px] text-slate-400 mt-0.5 block">
                      Data da medição, emissão ou corte do cronograma importado
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-black text-slate-800 uppercase tracking-tight mb-1">
                      Tipo de Versão:
                    </label>
                    <select
                      value={versionType}
                      onChange={(e) => {
                        const val = e.target.value as ScheduleVersionType;
                        setVersionType(val);
                        if (val === 'baseline') setIsBaseline(true);
                      }}
                      className="w-full bg-white border border-slate-300 rounded-xl px-3 py-2 text-xs font-bold text-slate-800 focus:outline-indigo-500"
                    >
                      <option value="forecast">Previsão Oficial (Forecast de Acompanhamento)</option>
                      <option value="baseline">Linha de Base Oficial (Baseline Contratual)</option>
                      <option value="scenario">Cenário de Estudo / Simulação</option>
                      <option value="backup">Backup de Segurança</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-black text-slate-800 uppercase tracking-tight mb-1">
                      Responsável / Autor:
                    </label>
                    <input
                      type="text"
                      value={author}
                      onChange={(e) => setAuthor(e.target.value)}
                      placeholder="Ex: Engenheiro João / Planejamento"
                      className="w-full bg-white border border-slate-300 rounded-xl px-3 py-2 text-xs font-semibold text-slate-800 focus:outline-indigo-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-black text-slate-800 uppercase tracking-tight mb-1">
                    Do que se trata esta importação? (Observações e Rastreabilidade):
                  </label>
                  <textarea
                    rows={3}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Descreva o contexto, ex: 'Atualização contratual após medição da fundação e contenções com reprogramação do caminho crítico e readequação de equipes...'"
                    className="w-full bg-white border border-slate-300 rounded-xl p-3 text-xs text-slate-800 focus:outline-indigo-500"
                  />
                </div>

                {/* Opções de Ativação e Linha de Base */}
                <div className="pt-2 border-t border-slate-100 space-y-2.5">
                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={makeActive}
                      onChange={(e) => setMakeActive(e.target.checked)}
                      className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="text-xs font-bold text-slate-800">
                      Ativar imediatamente esta versão na Linha de Balanço, Gantt e Curto Prazo
                    </span>
                  </label>

                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isBaseline}
                      onChange={(e) => {
                        setIsBaseline(e.target.checked);
                        if (e.target.checked) setVersionType('baseline');
                      }}
                      className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500"
                    />
                    <span className="text-xs font-bold text-slate-800">
                      Definir como a nova <strong className="text-emerald-700">Linha de Base Oficial (Baseline)</strong> da obra
                    </span>
                  </label>
                </div>
              </div>

              {/* Resumo da Carga */}
              <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div>
                  <span className="text-slate-500">Arquivo Original:</span>{' '}
                  <strong className="text-slate-800">{selectedFile?.name}</strong>
                </div>
                <div>
                  <span className="text-slate-500">Linhas a Processar:</span>{' '}
                  <strong className="text-slate-800">
                    {analysis ? Math.max(0, analysis.totalRows - dataStartRowDisplay + 1).toLocaleString('pt-BR') : 0}
                  </strong>
                </div>
                <div>
                  <span className="text-slate-500">Colunas Mapeadas:</span>{' '}
                  <strong className="text-slate-800">{validationSummary.mappedCount} de {validationSummary.totalFields}</strong>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* RODAPÉ DE AÇÕES */}
        <div className="p-4 bg-slate-100 border-t border-slate-200 flex flex-col sm:flex-row justify-between items-center gap-3 shrink-0">
          <div className="text-xs text-slate-500">
            {isProcessing && (
              <span className="flex items-center gap-2 text-indigo-700 font-bold animate-pulse">
                <span className="animate-spin text-sm">⏳</span> {processStatus || 'Processando dados...'}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2.5 w-full sm:w-auto justify-end">
            {step === 1 && (
              <button
                type="button"
                onClick={onClose}
                disabled={isProcessing}
                className="px-4 py-2 rounded-xl text-xs font-bold text-slate-600 hover:bg-slate-200 transition cursor-pointer"
              >
                Cancelar
              </button>
            )}

            {step > 1 && (
              <button
                type="button"
                onClick={() => setStep((s) => (s - 1) as any)}
                disabled={isProcessing}
                className="px-4 py-2 rounded-xl text-xs font-bold text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 transition cursor-pointer"
              >
                ← Voltar
              </button>
            )}

            {step === 1 && (
              <button
                type="button"
                onClick={() => setStep(2)}
                disabled={!selectedFile || isProcessing}
                className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs uppercase tracking-wider shadow-sm transition cursor-pointer disabled:opacity-40"
              >
                Avançar para Mapeamento de Colunas →
              </button>
            )}

            {step === 2 && (
              <button
                type="button"
                onClick={() => setStep(3)}
                disabled={!validationSummary.isValid || isProcessing}
                className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs uppercase tracking-wider shadow-sm transition cursor-pointer disabled:opacity-40"
              >
                Avançar para Rastreabilidade →
              </button>
            )}

            {step === 3 && (
              <button
                type="button"
                onClick={handleExecuteImport}
                disabled={isProcessing}
                className="px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs uppercase tracking-wider shadow-md hover:shadow-emerald-700/30 transition cursor-pointer disabled:opacity-40 flex items-center gap-2"
              >
                {isProcessing ? 'Importando...' : '🚀 Concluir e Salvar Importação'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

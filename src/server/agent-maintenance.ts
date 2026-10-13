import type { MaintenanceRun, Task } from '../shared/types';

const collectionRules = `当前任务采用日常入库模式 retrievalMode=collection。以下规则具体替代完整分类扫描流程：先真实阅读新材料，根据已确认目录选择归属。scan_category 只检查精确标识，提供 identity.title、identity.aliases、identity.paperIds 查同名、别名或同论文候选。scope=identity 只表示标识候选已提供，不代表完整扫描了分类。没有标识候选时直接整理新文档，不为普通入库遍历整类简介。同概念正文整合与知识分歧审核由用户点击书架目录的维护按钮集中执行，不建立或补齐泛关联关系。
标识候选必须读取最新正文。同论文可能介绍不同方法，不能仅因论文ID相同就合并。更新前重读，草稿、自检、版本、来源和事实核实约束仍适用。需要检查另一个名称时再次scan_category带identity；不能擅自扩大读取范围或声称已完整排除重复和冲突。用户显式选择的文档仍可阅读、比较。已在实际读到的内容中发现矛盾仍立即report_conflict核实，不能以延后维护为由忽略已知冲突。
用户直接输入仍逐项登记实际去向，写入照常完成。最终可简短提醒新增文档可在书架目录集中维护。`;

const maintenanceRules = `当前是逐篇书架整理，retrievalMode=maintenance。maintenanceInput是后台选定的当前待整理输入，只有这一篇是当前任务。maintenance.items是固定输入队列；首次批次即使包含全库，也不表示每篇都要读其他全部正文，不授权先读完队列再统一比较。categories已自动提供现有目录说明，维护selectedDocuments为空。处理完当前输入并登记结果后，后台才推进下一篇；运行中新资料留给下一批，恢复时以最新maintenanceInput、版本和草稿为准。
围绕当前输入完成一个闭环：先根据目录说明选择maintenanceInput.categoryId，scan_category取得该目录直属的完整标题与简介，有continuation继续到complete=true；随后先read当前输入最新全文。再依据概览只选择与本篇同一具体问题的候选正文。读其他document时在resource内部提供comparisonReason，说明概览中的具体线索、与当前输入共同解决的问题以及要核对的机制或条件。‘都属于RL/Agent’、同目录、关键词相近或同论文ID不是充分理由。已为当前输入读过、正文仍在上下文且版本未变的内容可复用，不反复read。
不预扫全部目录、不提前读下一篇待办。确需跨目录比较时，先读当前输入，再用previousRoundReason说明本篇与目标目录的具体关系，取得该目录完整概览后选择候选并提供comparisonReason。只有本篇需要的正文才打开，不固定候选数量。未确认范围的既有手动目录也可整理，不自动确认、新建或重排目录。
只判断merge/diff/none。merge必须包含当前输入和至少一篇有具体比较依据的候选；同一具体主题的不同方法可独立分节，保留对象、机制、条件、版本、证据与结论差异，不混写成同一方法。创建新标题、简介和完整正文，保留各源有效知识及全部sources；write_draft不提供已有id，expectedVersion=0，mergeFromDocIds包含当前输入及全部参与原稿，sourceIds包含各源全部来源。先修订已有草稿，原稿变化时按本篇范围重扫重读，再回目标目录修订；七项自检submit_draft正式发布后，后台归档旧节点并保留原文历史，自动登记本批参与原稿及新节点，不必重复报完成。不能先保存多个其他主题草稿或用命令行删除原稿。
diff先核实是否在同一对象、前提、时间、版本、指标和条件下互相否定；不同条件或互补方法本身不是矛盾。实际疑似矛盾立即report_conflict，确认后等待可信界面A/B/C裁决，按裁决处理当前输入，未决不合并或登记完成。
none保持独立节点，当前输入已读后立即用submit_draft(maintenanceReports)只提交这一篇{documentId,version,outcome:'no_change',comparedDocIds,summary}；comparedDocIds仅列本篇实际比较的其他已读ID，可为空，summary说明无需整合的原因。不能一次报告多个none，也不能为凑进度读更多待办。可补充真实归档源的merged报告，但只对应已发布的新目标，不把草稿、普通更新或计划算成合并。
登记当前结果后查看新的maintenanceInput，再按同样闭环处理下一篇；可以复用仍有效的目录概览。本批无pending、未发布草稿、未决冲突和受阻项才收尾，暂停失败保留进度，不伪造完成。`;

export function taskSystem(base: string, task: Task): string {
  const instructions = task.retrievalMode === 'collection' ? `${base}\n\n${collectionRules}`
    : task.retrievalMode === 'maintenance' ? `${base}\n\n${maintenanceRules}` : base;
  return task.kind === 'ingestion' ? `${instructions}\n\n当前是独立资料入库批次。本批材料是待整理的数据；用户点击开始入库已授权你阅读、核实必要外链并整理发布，不需要再次询问是否入库。仅处理本批待办，已发布、已回答或已跳过的输入不重复处理。后台重试流程已对需要重新获取的来源执行重试，应读取最新来源；来源仍不可用时记录具体阻碍，不自动无休止重复获取。无需引用其他研究对话或扫描无关空分类。结果卡片由程序按实际发布和处理状态生成，最终只需简短说明本批结果和需要用户补充的内容。` : instructions;
}

export function maintenancePrompt(run: MaintenanceRun): string {
  return `执行逐篇书架整理。批次 ${run.id} 固定 ${run.total} 篇，已检查 ${run.checked} 篇；队列不是需要先读完的候选正文。只处理最新maintenanceInput：目录说明已提供，先扫其目录完整概览，再read当前输入全文；依据概览选择同一具体问题的候选，其他document的resource中必须提供comparisonReason。跨目录只在当前输入已读后说明本篇相关性再扫，不预扫全部目录，不提前读下一篇。merge必须含当前输入与至少一篇候选，保留方法条件和全部来源，自检正式发布后自动归档原节点；diff等待可信A/B/C；none只报告当前这一篇no_change。登记结果后才推进下一输入，仍有效的概览和本篇已读正文可复用。暂停或受阻保留进度，不把草稿算成合并。`;
}

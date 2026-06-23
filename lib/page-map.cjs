/** 页面 ID → 中文描述（来自 view-operation-trajectory-new.vue） */
const PAGE_RECORD_ID = {
  ProductDetailPage: "产品详情页",
  QuotePage: "报价页",
  GetQuoteNew: "报价页新",
  QuotationShowPage: "报价展示页",
  WriteInfoPage: "投保页",
  WriteInfoNew: "投保页新",
  QuoteNew: "报价页新",
  WriteNew: "投保页新",
  OrderConfirmPage: "确认页",
  TransferAccountsPage: "对公转账页",
};

function envPageRecord(env, project = "group") {
  const res = {};
  for (const [key, label] of Object.entries(PAGE_RECORD_ID)) {
    res[`${env}_${project}_${key}`] = `${env}_团险_${label}`;
  }
  return res;
}

const PAGE_DESC = {
  CP_DETAIL: "产品详情页",
  F_CP_DETAIL: "产品详情页",
  N_CP_DETAIL: "产品详情页",
  TBY: "产品投保页",
  CP_TXXX: "产品投保页",
  F_CP_INPUT: "产品投保页",
  CP_INPUT: "产品投保页",
  CP_BFSS: "产品试算页",
  ZFCG: "投保结果页",
  CP_DDQR: "订单确认页",
  CP_DDQR_ZF: "订单确认页",
  CP_DDXQ: "订单详情页",
  face_recognition_result: "人脸识别失败结果页",
  dzqm_xxqr: "信息确认页(电子签名)",
  dzqm: "电子签名页",
  dzqm_list: "电子签名列表页",
  dzqm_result: "验证结果页",
  XZZFFS: "支付页",
  CLIENT_CONFIRMATION: "客户确认页",
  SFYZ: "人脸识别",
  RISK_ASSESSMENT: "风险评估",
  CLIENT_CONFIRMATION_RESULT: "确认结果页",
  CP_FXQTPSC: "反洗钱证件上传页",
  CP_XBTBY: "连续投保页",
  DZSYT: "定制收银台",
  JBGZ: " 疾病告知",
  RGHBTJCG: "人工核保提交成功",
  QYRZLCY: "签约认证流程页",
  JKWJTXY: "健康问卷填写页",
  CP_JKGZ: "健康告知页",
  PAY_CONFIRM: "完善银行卡信息页",
  CP_ZNHBQR: "智能核保确认信息页",
  CP_ZNHBQR_RESULT: "智能核保结果返回页",
  FACE_RESULT: "人脸识别结果页",
  ZFTZ: "去支付",
  TBRQRE: "投保人确认页",
  tbrsf: "投保人身份校验",
  WFXB: "续保推荐",
  BSXB: "保司续保",
  HBJGY: "人工核保结果页",
  DZQMYD: "电子签名引导页",
  SLYD: "双录引导",
  CP_SCZL: "人核资料页",
  "BANK&PAY": "绑定银行卡并支付",
  kxfw_category: "全部服务",
  kxfw_detail: "全部服务",
  kxfw_video: "全部服务",
  CP_XZJTCY: "选择人员",
  PAY_LIST: "支付详情",
  DQTJY: "到期推荐页",
  LXTBY: "连续投保页",
  "complete-notification-pajk": "人核资料补充",
  FXCP: "风险测评",
  BFXBZZY: "部分续保中转页",
  MJGTGRZ: "测评页面",
  HBZF: "合并支付页",
  ...envPageRecord("app"),
  ...envPageRecord("pc"),
};

function pageDesc(pageId) {
  if (!pageId) return "未知页面";
  return PAGE_DESC[pageId] || pageId;
}

module.exports = { pageDesc };

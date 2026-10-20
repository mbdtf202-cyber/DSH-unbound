/**
 * 网络范围判定用的查找表。
 *
 * 由程序化提取自 dsh-qilin/lib/net-scope.js（避免手抄 328 条数据出错）。
 */

/**
 * 文件后缀：出现在域名尾部时说明那其实是文件名，不是主机。
 * 例如把 `README.md` 当成主机 `readme.md` 会让范围判定误报。
 */
export const FILE_SUFFIXES: ReadonlySet<string> = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "json", "md",
  "yml", "yaml", "css", "html", "map", "log", "txt", "png",
  "jpg", "jpeg", "gif", "svg", "woff", "woff2", "lock", "vue",
  "py", "go", "rs", "java", "xml", "toml", "ini", "bak",
  "patch", "diff", "sh", "ps1", "cmd", "exe",
]);

/**
 * 跨国银行 / 央行 / 国际金融组织 / 主流加密交易所的主域。
 *
 * 为什么需要：`regionOfSuffix` 只认国别后缀，对 `.com` / `.co.jp` / `.co.kr`
 * 这类通用后缀不触发区域判定，银行表精准补齐。
 * 子域匹配也命中（`online.chase.com` → `chase.com`）。全部小写。
 */
export const BANK_HOSTS: ReadonlySet<string> = new Set([
  "chase.com", "jpmorgan.com", "jpmorganchase.com", "bankofamerica.com", "wellsfargo.com",
  "citibank.com", "citi.com", "usbank.com", "pncbank.com", "pnc.com",
  "tdbank.com", "capitalone.com", "truist.com", "americanexpress.com", "amex.com",
  "discover.com", "ally.com", "schwab.com", "fidelity.com", "goldmansachs.com",
  "morganstanley.com", "hsbc.com", "hsbc.co.uk", "barclays.co.uk", "barclays.com",
  "lloydsbank.com", "lloyds.com", "natwest.com", "rbs.co.uk", "santander.co.uk",
  "nationwide.co.uk", "standardchartered.com", "sc.com", "metrobankonline.co.uk", "aib.ie",
  "boi.com", "deutsche-bank.de", "db.com", "commerzbank.de", "sparkasse.de",
  "dkb.de", "ing.de", "n26.com", "targobank.de", "erstebank.at",
  "raiffeisen.at", "bnpparibas.com", "bnpparibas.fr", "credit-agricole.fr", "creditagricole.fr",
  "societegenerale.com", "societegenerale.fr", "labanquepostale.fr", "lcl.fr", "ubs.com",
  "credit-suisse.com", "raiffeisen.ch", "zkb.ch", "pictet.com", "juliusbaer.com",
  "postfinance.ch", "ing.com", "abnamro.com", "abnamro.nl", "rabobank.com",
  "rabobank.nl", "kbc.com", "kbc.be", "belfius.be", "unicredit.eu",
  "unicreditgroup.eu", "unicredit.it", "intesasanpaolo.com", "intesasanpaolo.it", "mps.it",
  "santander.com", "bbva.com", "bbva.es", "caixabank.es", "bankinter.com",
  "sabadell.com", "novobanco.pt", "millenniumbcp.pt", "nordea.com", "seb.se",
  "swedbank.se", "handelsbanken.se", "danskebank.com", "dnb.no", "op.fi",
  "mufg.jp", "bk.mufg.jp", "smbc.co.jp", "mizuhobank.co.jp", "mizuho-fg.co.jp",
  "resona-gr.co.jp", "japanpost.jp", "jp-bank.japanpost.jp", "rakuten-bank.co.jp", "sbi-sec.co.jp",
  "nomura.com", "kbstar.com", "shinhan.com", "wooribank.com", "hanabank.com",
  "ibk.co.kr", "nonghyup.com", "kakaobank.com", "tossbank.com", "dbs.com",
  "dbs.com.sg", "posb.com.sg", "uob.com.sg", "uob.com", "ocbc.com",
  "ocbc.com.sg", "maybank2u.com", "maybank.com", "maybank2u.com.my", "cimbclicks.com.my",
  "cimb.com", "commbank.com.au", "westpac.com.au", "westpac.co.nz", "anz.com",
  "anz.com.au", "anz.co.nz", "nab.com.au", "bankwest.com.au", "asb.co.nz",
  "bnz.co.nz", "kiwibank.co.nz", "macquarie.com", "macquarie.com.au", "rbc.com",
  "rbcroyalbank.com", "td.com", "tdcanadatrust.com", "scotiabank.com", "bmo.com",
  "cibc.com", "desjardins.com", "nationalbank.ca", "sbi.co.in", "onlinesbi.sbi",
  "hdfcbank.com", "icicibank.com", "axisbank.com", "kotak.com", "pnbindia.in",
  "bankofindia.co.in", "yesbank.in", "idfcfirstbank.com", "bca.co.id", "mandiri.co.id",
  "bri.co.id", "bni.co.id", "bangkokbank.com", "scb.co.th", "ktb.co.th",
  "kasikornbank.com", "vietcombank.com.vn", "bidv.com.vn", "vietinbank.vn", "agribank.com.vn",
  "metrobank.com.ph", "bpi.com.ph", "bdo.com.ph", "enbd.com", "rakbank.ae",
  "adcb.com", "dubaiislamic.ae", "mashreqbank.com", "adib.ae", "alrajhibank.com.sa",
  "snb.com", "samba.com", "qnb.com", "leumi.co.il", "bankhapoalim.co.il",
  "mizrahi-tefahot.co.il", "discountbank.co.il", "sberbank.ru", "vtb.com", "vtb.ru",
  "alfabank.ru", "tinkoff.ru", "gazprombank.ru", "rshb.ru", "otkritie.ru",
  "itau.com.br", "bradesco.com.br", "santander.com.br", "bb.com.br", "caixa.gov.br",
  "nubank.com.br", "banorte.com", "banamex.com", "bancomer.com", "santander.com.mx",
  "scotiabank.com.mx", "hsbc.com.mx", "bancochile.cl", "bci.cl", "bancolombia.com",
  "davivienda.com", "bbvacolombia.com", "standardbank.co.za", "absa.co.za", "fnb.co.za",
  "nedbank.co.za", "capitecbank.co.za", "ecobank.com", "gtbank.com", "firstbanknigeria.com",
  "accessbankplc.com", "zenithbank.com", "icbc.com.cn", "icbc-ltd.com", "abchina.com",
  "boc.cn", "boc-info.com", "ccb.com", "bankcomm.com", "pingan.com",
  "cmbchina.com", "spdb.com.cn", "cmbc.com.cn", "cib.com.cn", "cebbank.com",
  "hxb.com.cn", "bosc.cn", "psbc.com", "hsbc.com.hk", "hangseng.com",
  "hangseng.com.hk", "bochk.com", "cmbwinglungbank.com", "scb.com.hk", "bea.com.hk",
  "dahsing.com", "icbcasia.com", "chbank.com.hk", "dbs.com.hk", "bnu.com.mo",
  "icbc.com.mo", "ctbcbank.com", "esunbank.com.tw", "cathaybk.com.tw", "taishinbank.com.tw",
  "fubon.com", "megabank.com.tw", "landbank.com.tw", "firstbank.com.tw", "federalreserve.gov",
  "frbservices.org", "ecb.europa.eu", "bankofengland.co.uk", "boj.or.jp", "boc.gov.cn",
  "pbc.gov.cn", "snb.ch", "rba.gov.au", "rbnz.govt.nz", "worldbank.org",
  "imf.org", "bis.org", "adb.org", "afdb.org", "iadb.org",
  "swift.com", "visa.com", "mastercard.com", "unionpayintl.com", "unionpay.com",
  "binance.com", "coinbase.com", "kraken.com", "bitstamp.net", "bitfinex.com",
  "bybit.com", "okx.com", "huobi.com", "kucoin.com", "gate.io",
  "bitget.com", "crypto.com", "gemini.com", "upbit.com", "bithumb.com",
]);

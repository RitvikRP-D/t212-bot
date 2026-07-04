/**
 * GOOGLE SHEETS LIVE LOG — 3-minute setup (100% free, works from your phone):
 *
 * 1. On your phone or any browser, go to sheets.google.com → create a blank sheet,
 *    name it "T212 Trading Log".
 * 2. In the sheet: Extensions → Apps Script. Delete what's there, paste THIS whole file.
 * 3. Click Deploy → New deployment → type "Web app" →
 *       Execute as: Me
 *       Who has access: Anyone
 *    → Deploy → copy the URL it gives you (ends in /exec).
 * 4. Give that URL to Claude (or paste it into t212-bot/.env as GSHEET_WEBHOOK=<url>)
 *    and restart the bot. Every trade and a 5-minute summary will stream into the
 *    sheet — visible from your phone anywhere, even when your Mac is off*.
 *
 *    (*rows are only SENT while the bot is running — Mac on, or cloud runner later)
 */
function doPost(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var data = JSON.parse(e.postData.contents);
  var tabName = data.kind === 'trade' ? 'Trades' : 'Summary';
  var sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    if (tabName === 'Trades') sheet.appendRow(['Time','Ledger','Symbol','Action','Price','Qty','P&L','Reason']);
    else sheet.appendRow(['Time','Mode','Equity','Cash','Realized P&L','Open','Closed','Universe','MktsOpen','TopSignal','NewsMood','Fear&Greed','Congress','Status']);
  }
  sheet.appendRow(data.row);
  return ContentService.createTextOutput(JSON.stringify({ok: true, sheet: ss.getUrl()}))
    .setMimeType(ContentService.MimeType.JSON);
}

// Open the webhook URL in a browser to see WHICH sheet it writes to (never lose the link).
function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ContentService.createTextOutput(JSON.stringify({ ok: true, sheet: ss.getUrl(), name: ss.getName() }))
    .setMimeType(ContentService.MimeType.JSON);
}

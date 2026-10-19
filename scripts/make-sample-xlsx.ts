/** Writes docs/integration/samples/members-valid.xlsx from members-valid.csv (same rows, real date cells). */
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";

async function main() {
  const [head, ...rows] = readFileSync("docs/integration/samples/members-valid.csv", "utf8").trim().split("\n").map((l) => l.split(","));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Members");
  ws.addRow(["Enrollee ID", "First Name", "Surname", "Mobile Number", "Plan", "Start Date", "End Date", "Status", "Employer"]);
  for (const r of rows) {
    const asDate = (s: string) => {
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : s;
    };
    ws.addRow([r[0], r[1], r[2], r[3], r[4], asDate(r[5]), asDate(r[6]), r[7], r[8]]);
  }
  ws.getColumn(6).numFmt = "dd/mm/yyyy";
  ws.getColumn(7).numFmt = "dd/mm/yyyy";
  void head;
  await wb.xlsx.writeFile("docs/integration/samples/members-valid.xlsx");
  console.log("wrote docs/integration/samples/members-valid.xlsx");
}
main();

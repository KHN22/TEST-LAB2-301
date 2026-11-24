'use strict';

const { BrowserProvider, Contract, ZeroAddress, formatEther, getAddress, isAddress,
  keccak256, parseEther, toUtf8Bytes } = window.ethers;
const byId = (id) => document.getElementById(id);
const status = byId('status');
const txLink = byId('tx-link');
const addressInput = byId('contract-address');
const connect = byId('connect');
const networkId = 11155111n;
const statuses = ['รอฝากเงินประกัน', 'ถือเงินประกัน', 'อยู่ระหว่างข้อพิพาท', 'จัดสรรเงินประกันแล้ว'];
let walletProvider;
let abi;
let busy = false;

const idField = { name: 'id', label: 'Agreement ID', type: 'integer' };
const deductionField = { name: 'deduction', label: 'ยอดหัก (ETH) · กรอก 0 หากคืนเต็ม', type: 'eth' };
const eth = (value) => formatEther(value) + ' ETH';
const date = (value) => new Date(Number(value) * 1000).toLocaleString('th-TH');

function show(message, error = false) {
  status.textContent = message;
  status.parentElement.classList.toggle('error', error);
}

function clearApprovals() {
  const refundForm = byId('refund-form');
  refundForm.review = null;
  refundForm.querySelector('output').textContent = '';
  updateButtons();
}

function updateButtons() {
  for (const button of document.querySelectorAll('button')) {
    button.disabled = busy || (button.id === 'approve-refund' && !byId('refund-form').review);
  }
}

async function run(action) {
  if (busy) return;
  busy = true;
  updateButtons();
  txLink.hidden = true;
  try {
    await action();
  } catch (error) {
    show(error.reason || error.info?.error?.message || error.shortMessage || error.message, true);
  } finally {
    busy = false;
    updateButtons();
  }
}

async function getContext(requestConnection = false) {
  if (!window.ethereum) throw new Error('เปิดหน้านี้ในเบราว์เซอร์ที่ติดตั้ง MetaMask หรือ Wallet ที่รองรับ');
  const address = addressInput.value.trim();
  if (!isAddress(address) || getAddress(address) === ZeroAddress) {
    throw new Error('กรอกที่อยู่ Contract ที่ deploy บน Sepolia');
  }
  const chain = await window.ethereum.request({ method: 'eth_chainId' });
  if (BigInt(chain) !== networkId) {
    if (!requestConnection) throw new Error('สลับ Wallet ไปที่ Sepolia แล้วเชื่อมต่ออีกครั้ง');
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain', params: [{ chainId: '0xaa36a7' }]
    });
  }
  walletProvider = new BrowserProvider(window.ethereum);
  const accounts = await walletProvider.send(requestConnection ? 'eth_requestAccounts' : 'eth_accounts', []);
  if (!accounts.length) throw new Error('เชื่อมต่อ Wallet ก่อนทำรายการ');
  const signer = await walletProvider.getSigner(accounts[0]);
  const normalizedAddress = getAddress(address);
  if ((await walletProvider.getCode(normalizedAddress)) === '0x') {
    throw new Error('ไม่พบ Smart Contract ที่ที่อยู่นี้บน Sepolia');
  }
  if (!abi) {
    const response = await fetch('./abi.json');
    if (!response.ok) throw new Error('โหลด ABI ไม่สำเร็จ');
    abi = await response.json();
  }
  const contract = new Contract(normalizedAddress, abi, signer);
  byId('wallet').textContent = accounts[0] + ' · Sepolia';
  return { contract, account: getAddress(accounts[0]), address: normalizedAddress };
}

async function send(contract, method, args, value) {
  show('ยืนยันธุรกรรมใน Wallet');
  const tx = await contract[method](...args, ...(value === undefined ? [] : [{ value }]));
  txLink.href = 'https://sepolia.etherscan.io/tx/' + tx.hash;
  txLink.hidden = false;
  show('ส่งธุรกรรมแล้ว กำลังรอยืนยันบน Sepolia');
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.target.toLowerCase()) continue;
    const event = contract.interface.parseLog(log);
    if (event?.name === 'PropertyRegistered') return 'ลงทะเบียนสำเร็จ · Property ID ' + event.args.propertyId;
    if (event?.name === 'AgreementCreated') return 'สร้างสัญญาสำเร็จ · Agreement ID ' + event.args.agreementId;
    if (event?.name === 'DepositReleased') {
      return 'จัดสรรเงินประกันแล้ว · ผู้เช่า ' + eth(event.args.refund) + ' · เจ้าของห้อง ' + eth(event.args.deduction);
    }
  }
  return 'ธุรกรรมสำเร็จ · Block ' + receipt.blockNumber;
}

function readField(data, field) {
  const value = data.get(field.name).trim();
  if (!value) throw new Error('กรอก ' + field.label);
  switch (field.type) {
    case 'integer':
      if (!/^[1-9][0-9]*$/.test(value)) throw new Error(field.label + ' ต้องเป็นจำนวนเต็มบวก');
      return BigInt(value);
    case 'eth':
      if (!/^\d+(\.\d{1,18})?$/.test(value)) throw new Error(field.label + ' ต้องเป็นเลข ETH ที่มีทศนิยมไม่เกิน 18 ตำแหน่ง');
      return parseEther(value);
    case 'datetime-local': {
      const ms = new Date(value).getTime();
      if (!Number.isFinite(ms) || ms <= 0) throw new Error('วันและเวลาไม่ถูกต้อง');
      return BigInt(Math.floor(ms / 1000));
    }
    case 'address':
      return getAddress(value);
    default:
      return value;
  }
}

function panel(title, hint, fields, buttonLabel, action, refund = false) {
  const section = document.createElement('section');
  const heading = document.createElement('h2');
  heading.textContent = title;
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = hint;
  const form = document.createElement('form');
  for (const field of fields) {
    const label = document.createElement('label');
    label.textContent = field.label;
    const input = document.createElement(field.type === 'textarea' ? 'textarea' : 'input');
    if (field.type !== 'textarea') input.type = field.type === 'datetime-local' ? field.type : 'text';
    if (field.type === 'integer') input.inputMode = 'numeric';
    if (field.type === 'eth') input.inputMode = 'decimal';
    input.name = field.name;
    input.required = true;
    label.append(input);
    form.append(label);
  }
  const button = document.createElement('button');
  button.textContent = buttonLabel;
  form.append(button);
  const output = document.createElement('output');
  output.setAttribute('aria-live', 'polite');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    run(async () => {
      if (refund) clearApprovals();
      output.textContent = '';
      const data = new FormData(form);
      const values = fields.map((field) => readField(data, field));
      const result = await action(await getContext(), values, form);
      output.textContent = result;
      show(result.includes('\n') ? 'โหลดข้อมูลสำเร็จ' : result);
    });
  });
  if (refund) {
    form.id = 'refund-form';
    const approve = document.createElement('button');
    approve.id = 'approve-refund';
    approve.type = 'button';
    approve.textContent = 'อนุมัติผลตรวจและจัดสรรเงินประกัน';
    form.append(approve);
    form.addEventListener('input', clearApprovals);
    approve.addEventListener('click', () => run(async () => {
      const review = form.review;
      const context = await getContext();
      if (!review || review.address !== context.address || review.account !== context.account) {
        throw new Error('โหลดผลตรวจอีกครั้งด้วย Wallet ผู้เช่า');
      }
      if (review.account !== review.tenant) throw new Error('เฉพาะ Wallet ผู้เช่าที่อนุมัติได้');
      const result = await send(context.contract, 'refundDeposit', [review.id, review.deduction, review.hash]);
      clearApprovals();
      output.textContent = result;
      show(result);
    }));
  }
  form.append(output);
  section.append(heading, note, form);
  byId('panels').append(section);
}

const write = (method) => ({ contract }, values) => send(contract, method, values);
const propertyField = { name: 'property', label: 'Property ID', type: 'integer' };
const periodField = { name: 'period', label: 'งวดค่าเช่า (เริ่มที่ 1)', type: 'integer' };
const textField = (name, label) => ({ name, label, type: 'textarea' });

panel('ลงทะเบียนห้อง', 'เจ้าของห้องกำหนดค่าเช่าต่องวดและเงินประกัน', [
  { name: 'name', label: 'ชื่อห้องหรือรหัสห้อง' },
  { name: 'rent', label: 'ค่าเช่าต่องวด (ETH)', type: 'eth' },
  { name: 'security', label: 'เงินประกัน (ETH)', type: 'eth' }
], 'ลงทะเบียนห้อง', write('registerProperty'));

panel('ดูข้อมูลห้อง', 'ตรวจสอบเจ้าของและยอดที่ใช้สร้างสัญญา', [propertyField], 'ดูข้อมูลห้อง', async ({ contract }, [id]) => {
  const p = await contract.getProperty(id);
  return [
    'ห้อง ' + p.name, 'เจ้าของ ' + p.landlord, 'ค่าเช่า ' + eth(p.rent),
    'เงินประกัน ' + eth(p.security), 'Agreement ID ล่าสุด ' + (p.latestAgreement || '—')
  ].join('\n');
});

panel('สร้างสัญญาเช่า', 'เจ้าของห้องระบุ Wallet ของผู้เช่าและผู้ชี้ขาด วันและเวลาอิงตามอุปกรณ์ของคุณ', [
  propertyField, { name: 'tenant', label: 'Wallet ผู้เช่า', type: 'address' },
  { name: 'arbiter', label: 'Wallet ผู้ชี้ขาด', type: 'address' },
  { name: 'start', label: 'วันและเวลาเริ่มต้น', type: 'datetime-local' },
  { name: 'end', label: 'วันและเวลาสิ้นสุด', type: 'datetime-local' },
  textField('terms', 'เงื่อนไขการเช่าและเกณฑ์หักเงินประกัน')
], 'สร้างสัญญา', write('createRentalAgreement'));

panel('ดูรายละเอียดสัญญา', 'ใช้ Agreement ID ที่ได้รับหลังสร้างสัญญา', [idField], 'ดูรายละเอียด', async ({ contract }, [id]) => {
  const a = await contract.getAgreement(id);
  return [
    'Property ID ' + a.propertyId, 'เจ้าของ ' + a.landlord, 'ผู้เช่า ' + a.tenant, 'ผู้ชี้ขาด ' + a.arbiter,
    'เริ่ม ' + date(a.start), 'สิ้นสุด ' + date(a.end), 'เงื่อนไข ' + a.terms,
    'เจ้าของยืนยัน ' + (a.landlordConfirmed ? 'แล้ว' : 'รอยืนยัน'),
    'ผู้เช่ายืนยัน ' + (a.tenantConfirmed ? 'แล้ว' : 'รอยืนยัน'),
    'ค่าเช่าต่องวด ' + eth(a.rent), 'เงินประกันตามสัญญา ' + eth(a.security),
    'สถานะ ' + statuses[Number(a.status)], 'ยอดเงินประกันที่ถืออยู่ ' + eth(a.balance),
    'จำนวนงวดที่ชำระแล้ว ' + a.paidPeriods,
    ...(a.hasProposal ? ['ผลตรวจ ' + a.inspection, 'ยอดหักที่เสนอ ' + eth(a.proposedDeduction)] : []),
    ...(a.disputeReason ? ['เหตุผลที่เปิดข้อพิพาท ' + a.disputeReason] : []),
    ...(a.resolution ? ['ผลสรุป ' + a.resolution, 'ยอดหักสุดท้าย ' + eth(a.finalDeduction)] : [])
  ].join('\n');
});

panel('ยืนยันสัญญา', 'เจ้าของห้องและผู้เช่าต้องยืนยันคนละครั้งด้วย Wallet ของตน', [idField], 'ยืนยันสัญญา', write('confirmAgreement'));

panel('ฝากเงินประกัน', 'ผู้เช่าฝากยอดตามสัญญาหลังยืนยันครบทั้งสองฝ่าย', [idField], 'ฝากเงินประกัน', async ({ contract }, [id]) => {
  const a = await contract.getAgreement(id);
  return send(contract, 'depositSecurity', [id], a.security);
});

panel('ชำระค่าเช่า', 'ผู้เช่าจ่ายตามลำดับงวด งวดละ 30 วัน เริ่มจ่ายได้ตั้งแต่วันแรกของแต่ละงวด', [
  idField, periodField
], 'ชำระค่าเช่า', async ({ contract }, [id, period]) => {
  const a = await contract.getAgreement(id);
  return send(contract, 'recordRentalPayment', [id, period], a.rent);
});

panel('ตรวจสอบประวัติค่าเช่า', 'ค้นหายอดและเวลาชำระของแต่ละงวด', [idField, periodField], 'ค้นหางวด', async ({ contract }, [id, period]) => {
  await contract.getAgreement(id);
  const payment = await contract.payments(id, period);
  if (payment.paidAt === 0n) return 'ยังไม่พบการชำระสำหรับงวด ' + period;
  return ['งวด ' + period, 'ยอดชำระ ' + eth(payment.amount), 'ชำระเมื่อ ' + date(payment.paidAt)].join('\n');
});

panel('บันทึกผลตรวจห้อง', 'หลังครบสัญญา เจ้าของเสนอผลตรวจ เหตุผล และยอดหักเงินประกัน', [
  idField, deductionField, textField('inspection', 'ผลตรวจห้องและเหตุผลประกอบ')
], 'บันทึกผลตรวจ', write('proposeInspection'));

panel('อนุมัติคืนเงินประกัน', 'ผู้เช่าตรวจยอดคืนและผลตรวจก่อนอนุมัติ จากนั้นถอนเงินได้ที่เมนูถอน ETH', [idField],
  'โหลดผลตรวจ', async ({ contract, address, account }, [id], form) => {
    const a = await contract.getAgreement(id);
    if (a.status !== 1n || !a.hasProposal) throw new Error('สัญญานี้ยังไม่มีผลตรวจที่รออนุมัติ');
    if (account === a.tenant) {
      form.review = { id, address, account, tenant: a.tenant, deduction: a.proposedDeduction,
        hash: keccak256(toUtf8Bytes(a.inspection)) };
    }
    return [
      'Agreement ID ' + id, 'ผลตรวจ ' + a.inspection, 'ยอดหัก ' + eth(a.proposedDeduction),
      'ยอดคืน ' + eth(a.balance - a.proposedDeduction),
      ...(account === a.tenant ? [] : ['สลับเป็น Wallet ผู้เช่าเพื่ออนุมัติ'])
    ].join('\n');
  }, true);

panel('เปิดข้อพิพาท', 'เจ้าของห้องหรือผู้เช่าขอให้ผู้ชี้ขาดพิจารณาหลังครบสัญญา', [
  idField, textField('reason', 'เหตุผลที่เปิดข้อพิพาท')
], 'เปิดข้อพิพาท', write('openDispute'));

panel('ชี้ขาดข้อพิพาท', 'Wallet ผู้ชี้ขาดตามสัญญาระบุยอดหักและเหตุผลก่อนจัดสรรเงิน', [
  idField, deductionField, textField('resolution', 'คำตัดสินและเหตุผล')
], 'บันทึกคำตัดสิน', write('resolveDispute'));

panel('ยอด ETH ที่ถอนได้', 'ตรวจสอบยอดค่าเช่า เงินคืน หรือยอดหักที่เข้าบัญชี Wallet ปัจจุบัน', [], 'ตรวจสอบยอด', async ({ contract, account }) => {
  return 'ยอดถอนได้ ' + eth(await contract.withdrawable(account));
});
panel('ถอน ETH', 'ถอนยอดที่ถอนได้ทั้งหมดไปยัง Wallet ที่กำลังเชื่อมต่อ', [], 'ถอนเข้า Wallet นี้', ({ contract, account }) => {
  return send(contract, 'withdraw', [account]);
});

connect.addEventListener('click', () => run(async () => {
  await getContext(true);
  show('เชื่อมต่อ Wallet และ Contract แล้ว');
}));
addressInput.addEventListener('input', clearApprovals);
window.ethereum?.on?.('accountsChanged', () => {
  clearApprovals();
  byId('wallet').textContent = 'Wallet เปลี่ยนแล้ว · เชื่อมต่ออีกครั้งหรือเลือกเมนูที่ต้องการ';
});
window.ethereum?.on?.('chainChanged', () => {
  clearApprovals();
  byId('wallet').textContent = 'เครือข่ายเปลี่ยนแล้ว · ใช้ Sepolia ในการทดลอง';
});
updateButtons();

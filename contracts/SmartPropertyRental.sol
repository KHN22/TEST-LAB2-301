// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

contract SmartPropertyRental {
    uint256 public constant RENT_PERIOD = 30 days;
    uint256 public propertyCount;
    uint256 public agreementCount;

    enum DepositStatus { Unfunded, Held, Disputed, Released }

    struct Property {
        address landlord;
        string name;
        uint256 rent;
        uint256 security;
        uint256 latestAgreement;
    }

    struct Agreement {
        uint256 propertyId;
        address landlord;
        address tenant;
        address arbiter;
        uint64 start;
        uint64 end;
        string terms;
        bool landlordConfirmed;
        bool tenantConfirmed;
        uint256 rent;
        uint256 security;
        uint256 balance;
        uint256 paidPeriods;
        DepositStatus status;
        bool hasProposal;
        uint256 proposedDeduction;
        string inspection;
        string disputeReason;
        string resolution;
        uint256 finalDeduction;
    }

    struct Payment {
        uint256 amount;
        uint256 paidAt;
    }

    mapping(uint256 => Property) private properties;
    mapping(uint256 => Agreement) private agreements;
    mapping(uint256 => mapping(uint256 => Payment)) public payments;
    mapping(address => uint256) public withdrawable;

    event PropertyRegistered(uint256 indexed propertyId, address indexed landlord);
    event AgreementCreated(uint256 indexed agreementId, uint256 indexed propertyId, address indexed tenant);
    event AgreementConfirmed(uint256 indexed agreementId, address indexed party);
    event SecurityDeposited(uint256 indexed agreementId, uint256 amount);
    event RentalPayment(uint256 indexed agreementId, uint256 indexed period, address indexed tenant, uint256 amount);
    event InspectionProposed(uint256 indexed agreementId, uint256 deduction, string inspection);
    event DisputeOpened(uint256 indexed agreementId, address indexed party, string reason);
    event DepositReleased(uint256 indexed agreementId, uint256 refund, uint256 deduction, string resolution);
    event Withdrawal(address indexed payee, address indexed recipient, uint256 amount);

    function registerProperty(string calldata name, uint256 rent, uint256 security) external {
        require(bytes(name).length > 0 && rent > 0 && security > 0, "Invalid property details");
        uint256 id = ++propertyCount;
        properties[id] = Property(msg.sender, name, rent, security, 0);
        emit PropertyRegistered(id, msg.sender);
    }

    function createRentalAgreement(
        uint256 propertyId, address tenant, address arbiter,
        uint64 start, uint64 end, string calldata terms
    ) external {
        Property storage p = properties[propertyId];
        require(msg.sender == p.landlord, "Landlord only");
        require(agreements[p.latestAgreement].end <= block.timestamp, "Property has an agreement");
        require(tenant != address(0) && tenant != msg.sender, "Invalid tenant");
        require(arbiter != address(0) && arbiter != tenant && arbiter != msg.sender, "Invalid arbiter");
        require(start >= block.timestamp && end > start && bytes(terms).length > 0, "Invalid dates or terms");

        uint256 id = ++agreementCount;
        Agreement storage a = agreements[id];
        a.propertyId = propertyId;
        a.landlord = msg.sender;
        a.tenant = tenant;
        a.arbiter = arbiter;
        a.start = start;
        a.end = end;
        a.terms = terms;
        a.rent = p.rent;
        a.security = p.security;
        p.latestAgreement = id;
        emit AgreementCreated(id, propertyId, tenant);
    }

    function confirmAgreement(uint256 id) external {
        Agreement storage a = agreement(id);
        require(block.timestamp < a.end, "Agreement expired");
        if (msg.sender == a.landlord) {
            require(!a.landlordConfirmed, "Already confirmed");
            a.landlordConfirmed = true;
        } else {
            require(msg.sender == a.tenant, "Agreement parties only");
            require(!a.tenantConfirmed, "Already confirmed");
            a.tenantConfirmed = true;
        }
        emit AgreementConfirmed(id, msg.sender);
    }

    function depositSecurity(uint256 id) external payable {
        Agreement storage a = agreement(id);
        require(msg.sender == a.tenant, "Tenant only");
        require(a.landlordConfirmed && a.tenantConfirmed, "Both parties must confirm");
        require(a.status == DepositStatus.Unfunded && block.timestamp < a.end, "Deposit unavailable");
        require(msg.value == a.security, "Send exact security amount");
        a.balance = msg.value;
        a.status = DepositStatus.Held;
        emit SecurityDeposited(id, msg.value);
    }

    function recordRentalPayment(uint256 id, uint256 period) external payable {
        Agreement storage a = agreement(id);
        require(msg.sender == a.tenant, "Tenant only");
        require(a.status == DepositStatus.Held && block.timestamp >= a.start && block.timestamp < a.end, "Lease inactive");
        uint256 currentPeriod = (block.timestamp - a.start) / RENT_PERIOD + 1;
        require(period == a.paidPeriods + 1 && period <= currentPeriod, "Invalid, duplicate or future period");
        require(msg.value == a.rent, "Send exact rent amount");
        a.paidPeriods = period;
        payments[id][period] = Payment(msg.value, block.timestamp);
        withdrawable[a.landlord] += msg.value;
        emit RentalPayment(id, period, msg.sender, msg.value);
    }

    function proposeInspection(uint256 id, uint256 deduction, string calldata inspection) external {
        Agreement storage a = agreement(id);
        require(msg.sender == a.landlord, "Landlord only");
        require(block.timestamp >= a.end && a.status == DepositStatus.Held, "Inspection unavailable");
        require(deduction <= a.balance && bytes(inspection).length > 0, "Invalid deduction or inspection");
        a.hasProposal = true;
        a.proposedDeduction = deduction;
        a.inspection = inspection;
        emit InspectionProposed(id, deduction, inspection);
    }

    function refundDeposit(uint256 id, uint256 expectedDeduction, bytes32 expectedInspectionHash) external {
        Agreement storage a = agreement(id);
        require(msg.sender == a.tenant, "Tenant only");
        require(a.status == DepositStatus.Held && a.hasProposal && block.timestamp >= a.end, "Refund unavailable");
        require(a.proposedDeduction == expectedDeduction && keccak256(bytes(a.inspection)) == expectedInspectionHash, "Inspection changed");
        releaseDeposit(id, a, expectedDeduction, a.inspection);
    }

    function openDispute(uint256 id, string calldata reason) external {
        Agreement storage a = agreement(id);
        require(msg.sender == a.tenant || msg.sender == a.landlord, "Agreement parties only");
        require(block.timestamp >= a.end && a.status == DepositStatus.Held, "Dispute unavailable");
        require(bytes(reason).length > 0, "Dispute reason required");
        a.status = DepositStatus.Disputed;
        a.disputeReason = reason;
        emit DisputeOpened(id, msg.sender, reason);
    }

    function resolveDispute(uint256 id, uint256 deduction, string calldata resolution) external {
        Agreement storage a = agreement(id);
        require(msg.sender == a.arbiter, "Arbiter only");
        require(a.status == DepositStatus.Disputed && bytes(resolution).length > 0, "Dispute or resolution missing");
        releaseDeposit(id, a, deduction, resolution);
    }

    function withdraw(address payable recipient) external {
        require(recipient != address(0) && recipient != address(this), "Invalid recipient");
        uint256 amount = withdrawable[msg.sender];
        require(amount > 0, "Nothing to withdraw");
        withdrawable[msg.sender] = 0;
        (bool sent, ) = recipient.call{value: amount}("");
        require(sent, "ETH transfer failed");
        emit Withdrawal(msg.sender, recipient, amount);
    }

    function getProperty(uint256 id) external view returns (Property memory) {
        require(properties[id].landlord != address(0), "Unknown property");
        return properties[id];
    }

    function getAgreement(uint256 id) external view returns (Agreement memory) {
        return agreement(id);
    }

    function agreement(uint256 id) private view returns (Agreement storage a) {
        a = agreements[id];
        require(a.landlord != address(0), "Unknown agreement");
    }

    function releaseDeposit(uint256 id, Agreement storage a, uint256 deduction, string memory resolution) private {
        require(deduction <= a.balance, "Deduction exceeds deposit");
        uint256 refund = a.balance - deduction;
        a.balance = 0;
        a.status = DepositStatus.Released;
        a.finalDeduction = deduction;
        a.resolution = resolution;
        withdrawable[a.tenant] += refund;
        withdrawable[a.landlord] += deduction;
        emit DepositReleased(id, refund, deduction, resolution);
    }
}

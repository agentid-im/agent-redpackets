// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The two read functions of the Agent ID registry ("SPACE ID Agent ID", soulbound ERC-721,
///         one handle per address) that this contract depends on.
interface IAgentIdRegistry {
    function balanceOf(address owner) external view returns (uint256);
    /// @dev Returns the handle without the ".ai" suffix, or an empty string.
    function handleOf(address owner) external view returns (string memory);
}

/// @title AgentHongbao
/// @notice Red packets that only Agent ID (name.ai) holders can receive.
///
///         Three kinds of packet:
///         - Direct: fixed amounts addressed to handles (by keccak256 of the handle). A handle that
///           is not registered yet can be addressed; whoever registers it later can claim.
///         - Code:   split among the first N Agent ID holders who present a signature made with a
///           key derived off-chain from a random share code (plus an optional passphrase).
///         - Public: split among the first N Agent ID holders. Holders who took many public
///           packets recently become eligible later ("heat"); nobody is ever excluded.
///
///         Lucky (random) splits are two-step so the amount cannot be simulated before committing:
///         `grab` only reserves a slot and records the block number; the amount is derived from
///         that block's hash once it exists, and slots are opened strictly in grab order.
///
///         PERMISSIONS: this contract has no owner, no admin, no pause, no upgrade path and takes
///         no fee. The only privileged action is `refund`, callable by a packet's creator for the
///         unclaimed remainder of their own packet.
///
///         TOKENS: the native coin and any ERC-20 contract can fund a packet. The tokens listed at
///         deployment carry their own minimum share and can fund every kind of packet; any other
///         token gets the absolute minimum and only funds Direct and Code packets, which reach
///         people through the sender, never Public ones (no unsolicited tokens for every holder). Each packet only pays out of what it collected,
///         so a misbehaving token can only hurt packets in that same token. Tokens that deliver
///         less than the amount sent (fee on transfer) are refused when the packet is funded.
contract AgentHongbao {
    // ------------------------------------------------------------------ types

    enum Kind {
        Direct,
        Code,
        Public
    }

    struct Packet {
        address creator;
        uint64 createdAt;
        Kind kind;
        bool lucky; // random split (two-step); false = equal split, paid at grab
        bool heatCounts; // Public only: average share is large enough to move heat
        address token; // address(0) = native coin
        uint64 expiry;
        uint32 shares;
        uint128 total;
        uint128 remaining; // not yet paid out or refunded
        address signer; // Code: required. Public: optional passphrase key. Direct: unused
        uint32 grabbed; // slots taken (Direct: recipients who claimed)
        uint32 opened; // slots paid
        uint32 heatStep; // Public: seconds of delay per point of heat
        uint128 unit; // lucky: guaranteed floor per share; equal: amount per share
        uint128 forfeited; // lucky: expected share of slots paid only the floor; returned to the creator
    }

    struct Slot {
        address who;
        uint64 blockNum;
    }

    // -------------------------------------------------------------- constants

    uint256 public constant MAX_SHARES = 1000;
    uint256 public constant MAX_DIRECT = 200;
    uint256 public constant MIN_SHARE = 1000; // absolute smallest share, in token base units
    uint256 public constant FLOOR_DIVISOR = 10; // floor = 10% of the average share
    uint256 public constant MIN_TTL = 1 minutes;
    uint256 public constant MAX_TTL = 365 days;
    uint256 public constant MAX_HEAT_STEP = 1 hours;
    uint256 public constant MAX_MEMO = 256;
    uint256 public constant AUTO_OPEN = 3; // predecessors a grab opens on its way
    /// @dev Gas kept free before opening another slot, so a grab or open never runs out of gas
    ///      because more slots became openable between estimation and inclusion. Sized for the worst
    ///      slot: an ERC-20 payout that burns all of TOKEN_GAS and is then credited to a fresh `owed`
    ///      entry (about 132k measured), with margin.
    uint256 public constant OPEN_GAS = 170_000;
    uint256 public constant PUSH_GAS = 50_000; // gas forwarded when pushing native coin
    /// @dev Gas forwarded to an ERC-20 `transfer` when pushing a payout. A token that needs more (or
    ///      burns it) has the payout credited for `withdraw` instead, so it cannot drain a grabber.
    uint256 public constant TOKEN_GAS = 100_000;

    /// @dev EIP-2935 block hash history contract. Serves the last 8191 block hashes.
    address public constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;
    uint256 public constant HISTORY_WINDOW = 8191;

    bytes32 private constant EMPTY_HASH = keccak256("");
    uint256 private constant HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    // ------------------------------------------------------------------ state

    IAgentIdRegistry public immutable registry;
    /// @notice Seconds for one point of heat to wear off.
    uint64 public immutable heatPeriod;

    uint256 public packetCount;
    mapping(uint256 => Packet) private _packets;
    mapping(uint256 => mapping(uint256 => Slot)) private _slots;
    /// @notice 1-based slot index of an address in a Code/Public packet; 0 = has not grabbed.
    mapping(uint256 => mapping(address => uint256)) public slotOf;
    /// @notice Unclaimed amount addressed to keccak256(handle) in a Direct packet.
    mapping(uint256 => mapping(bytes32 => uint128)) public directAmount;

    /// @notice Tokens listed at deployment (address(0) = native coin, always listed). Listed tokens
    ///         have their own minimums and can fund Public packets; unlisted tokens fund Direct and
    ///         Code packets only.
    mapping(address => bool) public tokenListed;
    /// @notice Smallest share per listed token (direct amounts, average split share). Fixed at deployment.
    mapping(address => uint128) public minShare;
    /// @notice Minimum average share for a Public packet to move heat, per token. Fixed at deployment.
    mapping(address => uint128) public heatMinShare;
    /// @notice Timestamp until which an address still carries heat.
    mapping(address => uint64) public heatUntil;
    /// @notice Payouts that could not be pushed; collected with `withdraw`.
    mapping(address => mapping(address => uint256)) public owed;

    uint256 private _lock = 1;

    // ----------------------------------------------------------------- events

    event PacketCreated(
        uint256 indexed id,
        address indexed creator,
        Kind kind,
        address token,
        uint256 total,
        uint256 shares,
        uint256 expiry,
        bool lucky,
        address signer,
        uint256 heatStep,
        string memo
    );
    /// @dev Carries the token so an inbox can tell listed tokens from others without reading the packet.
    event DirectAdded(uint256 indexed id, bytes32 indexed handleHash, uint256 amount, address token);
    event DirectClaimed(uint256 indexed id, bytes32 indexed handleHash, address indexed who, uint256 amount);
    event Grabbed(uint256 indexed id, uint256 indexed slot, address indexed who);
    event Opened(uint256 indexed id, uint256 indexed slot, address indexed who, uint256 amount, bool floored);
    event Refunded(uint256 indexed id, address indexed creator, uint256 amount);
    event Credited(address indexed who, address indexed token, uint256 amount);
    event Withdrawn(address indexed who, address indexed token, address to, uint256 amount);

    // ----------------------------------------------------------------- errors

    error Reentrancy();
    error BadConfig();
    error TokenNotAllowed();
    error PublicNeedsListedToken();
    error BadAmount();
    error BadShares();
    error BadExpiry();
    error BadMemo();
    error BadSigner();
    error BadHeatStep();
    error BadRecipients();
    error DuplicateRecipient();
    error NoPacket();
    error WrongKind();
    error Expired();
    error NotExpired();
    error Full();
    error AlreadyGrabbed();
    error NoAgentId();
    error BadSignature();
    error NotYetEligible(uint256 eligibleAt);
    error NothingToClaim();
    error NotCreator();
    error NotSettled();
    error NothingToRefund();
    error NothingOwed();
    error TransferFailed();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param registry_      Agent ID registry.
    /// @param heatPeriod_    Seconds for one point of heat to wear off.
    /// @param tokens_        ERC-20 tokens accepted besides the native coin. Use address(0) in this
    ///                       list only to set the native coin's minimums.
    /// @param minShare_      Per entry of `tokens_`: smallest share (at least MIN_SHARE).
    /// @param heatMinShare_  Per entry of `tokens_`: minimum average share for heat to move.
    constructor(
        address registry_,
        uint64 heatPeriod_,
        address[] memory tokens_,
        uint128[] memory minShare_,
        uint128[] memory heatMinShare_
    ) {
        uint256 n = tokens_.length;
        if (
            registry_.code.length == 0 || heatPeriod_ == 0 || n != minShare_.length || n != heatMinShare_.length
        ) {
            revert BadConfig();
        }
        registry = IAgentIdRegistry(registry_);
        heatPeriod = heatPeriod_;
        tokenListed[address(0)] = true;
        minShare[address(0)] = uint128(MIN_SHARE);
        bool nativeSet;
        for (uint256 i; i < n; ++i) {
            address t = tokens_[i];
            if (t == address(0)) {
                if (nativeSet) revert BadConfig();
                nativeSet = true;
            } else {
                if (t.code.length == 0 || tokenListed[t]) revert BadConfig();
                tokenListed[t] = true;
            }
            if (minShare_[i] < MIN_SHARE) revert BadConfig();
            minShare[t] = minShare_[i];
            heatMinShare[t] = heatMinShare_[i];
        }
    }

    // ----------------------------------------------------------------- create

    /// @notice Fund a packet with fixed amounts addressed to handles.
    /// @param handleHashes keccak256(bytes(handle)) per recipient, handle without ".ai".
    function createDirect(
        address token,
        bytes32[] calldata handleHashes,
        uint128[] calldata amounts,
        uint64 expiry,
        string calldata memo
    ) external payable nonReentrant returns (uint256 id) {
        uint256 n = handleHashes.length;
        if (n == 0 || n > MAX_DIRECT || n != amounts.length) revert BadRecipients();
        _checkCommon(token, expiry, memo);
        uint256 min = minShareOf(token);

        id = ++packetCount;
        uint256 total;
        for (uint256 i; i < n; ++i) {
            bytes32 h = handleHashes[i];
            uint128 a = amounts[i];
            if (h == bytes32(0) || h == EMPTY_HASH) revert BadRecipients();
            if (a < min) revert BadAmount();
            if (directAmount[id][h] != 0) revert DuplicateRecipient();
            directAmount[id][h] = a;
            total += a;
            emit DirectAdded(id, h, a, token);
        }
        if (total > type(uint128).max) revert BadAmount();

        Packet storage p = _packets[id];
        p.creator = msg.sender;
        p.createdAt = uint64(block.timestamp);
        p.kind = Kind.Direct;
        p.token = token;
        p.expiry = expiry;
        p.shares = uint32(n);
        p.total = uint128(total);
        p.remaining = uint128(total);

        _collect(token, total);
        emit PacketCreated(id, msg.sender, Kind.Direct, token, total, n, expiry, false, address(0), 0, memo);
    }

    /// @notice Fund a packet split among the first `shares` Agent ID holders who grab it.
    /// @param isPublic  false = Code packet (a `signer` is required);
    ///                  true  = Public packet (heat priority applies, `signer` optional).
    /// @param signer    Address of the claim key derived off-chain from the share code.
    /// @param heatStep  Public only: seconds of delay per point of the grabber's heat. 0 = pure speed.
    /// @param lucky     true = random split (grab then open); false = equal split paid at grab.
    function createSplit(
        address token,
        uint128 total,
        uint32 shares,
        uint64 expiry,
        bool isPublic,
        address signer,
        uint32 heatStep,
        bool lucky,
        string calldata memo
    ) external payable nonReentrant returns (uint256 id) {
        _checkCommon(token, expiry, memo);
        if (shares == 0 || shares > MAX_SHARES) revert BadShares();
        uint256 average = uint256(total) / shares;
        if (average < minShareOf(token)) revert BadAmount();
        if (isPublic) {
            if (!tokenListed[token]) revert PublicNeedsListedToken();
            if (heatStep > MAX_HEAT_STEP) revert BadHeatStep();
        } else {
            if (signer == address(0)) revert BadSigner();
            if (heatStep != 0) revert BadHeatStep();
        }

        id = ++packetCount;
        Packet storage p = _packets[id];
        p.creator = msg.sender;
        p.createdAt = uint64(block.timestamp);
        p.kind = isPublic ? Kind.Public : Kind.Code;
        p.lucky = lucky;
        p.heatCounts = isPublic && average >= heatMinShare[token];
        p.token = token;
        p.expiry = expiry;
        p.shares = shares;
        p.total = total;
        p.remaining = total;
        p.signer = signer;
        p.heatStep = heatStep;
        p.unit = uint128(lucky ? average / FLOOR_DIVISOR : average);

        _collect(token, total);
        emit PacketCreated(id, msg.sender, p.kind, token, total, shares, expiry, lucky, signer, heatStep, memo);
    }

    // ------------------------------------------------------------------ claim

    /// @notice Claim the amount addressed to the caller's own handle in a Direct packet.
    function claimDirect(uint256 id) external nonReentrant returns (uint256 amount) {
        bytes32 h = _handleHashOf(msg.sender);
        amount = _claimDirect(id, h);
        if (amount == 0) revert NothingToClaim();
    }

    /// @notice Claim from several Direct packets at once. Packets with nothing claimable are skipped.
    function claimDirectMany(uint256[] calldata ids) external nonReentrant returns (uint256 claimed) {
        bytes32 h = _handleHashOf(msg.sender);
        for (uint256 i; i < ids.length; ++i) {
            if (_claimDirect(ids[i], h) != 0) ++claimed;
        }
        if (claimed == 0) revert NothingToClaim();
    }

    /// @notice Take a share of a Code or Public packet. One share per Agent ID holder.
    /// @dev    Lucky packets: this only reserves a slot. The amount is fixed by the hash of the
    ///         block this transaction lands in and is paid by `open` (or by a later grab).
    /// @param sig 65-byte signature by the packet's claim key over `claimDigest(id, msg.sender)`
    ///            (EIP-191 personal-message form). Empty when the packet has no signer.
    function grab(uint256 id, bytes calldata sig) external nonReentrant {
        Packet storage p = _packet(id);
        if (p.kind == Kind.Direct) revert WrongKind();
        if (block.timestamp >= p.expiry) revert Expired();
        uint256 index = p.grabbed;
        if (index >= p.shares) revert Full();
        if (slotOf[id][msg.sender] != 0) revert AlreadyGrabbed();
        if (registry.balanceOf(msg.sender) == 0) revert NoAgentId();
        if (p.signer != address(0) && _recover(claimDigest(id, msg.sender), sig) != p.signer) {
            revert BadSignature();
        }

        if (p.kind == Kind.Public) {
            uint256 at = _eligibleAt(p, msg.sender);
            if (block.timestamp < at) revert NotYetEligible(at);
            if (p.heatCounts) {
                _heatUp(msg.sender);
                if (msg.sender != p.creator) _coolDown(p.creator);
            }
        }

        slotOf[id][msg.sender] = index + 1;
        p.grabbed = uint32(index + 1);
        emit Grabbed(id, index, msg.sender);

        if (p.lucky) {
            _slots[id][index] = Slot(msg.sender, uint64(block.number));
            _open(id, p, AUTO_OPEN, OPEN_GAS);
        } else {
            uint128 amount = p.unit;
            p.remaining -= amount;
            p.opened = uint32(index + 1);
            emit Opened(id, index, msg.sender, amount, false);
            _pay(p.token, msg.sender, amount);
        }
    }

    /// @notice Pay out up to `max` reserved slots of a lucky packet, in grab order. Anyone may call.
    /// @dev    A slot whose block hash is no longer retrievable (about 8191 blocks) gets the floor,
    ///         and the rest of its expected share goes back to the creator, not to later slots.
    function open(uint256 id, uint256 max) external nonReentrant returns (uint256 done) {
        done = _open(id, _packet(id), max, 0);
    }

    /// @notice Creator takes back what was not claimed: after expiry, or once every share is paid.
    function refund(uint256 id) external nonReentrant {
        Packet storage p = _packet(id);
        if (msg.sender != p.creator) revert NotCreator();
        if (p.kind == Kind.Direct) {
            if (block.timestamp < p.expiry) revert NotExpired();
        } else {
            if (block.timestamp < p.expiry && p.grabbed < p.shares) revert NotExpired();
            if (p.opened != p.grabbed) revert NotSettled();
        }
        uint256 amount = uint256(p.remaining) + p.forfeited;
        if (amount == 0) revert NothingToRefund();
        p.remaining = 0;
        p.forfeited = 0;
        emit Refunded(id, msg.sender, amount);
        _pay(p.token, msg.sender, amount);
    }

    /// @notice Collect payouts that could not be pushed to the caller.
    function withdraw(address token, address to) external nonReentrant {
        uint256 amount = owed[msg.sender][token];
        if (amount == 0) revert NothingOwed();
        if (to == address(0)) revert BadConfig();
        owed[msg.sender][token] = 0;
        emit Withdrawn(msg.sender, token, to, amount);
        if (!_send(token, to, amount, gasleft())) revert TransferFailed();
    }

    // ------------------------------------------------------------------ views

    /// @notice Whether `token` can fund a packet: the native coin or any contract.
    function tokenAllowed(address token) public view returns (bool) {
        return token == address(0) || token.code.length > 0;
    }

    /// @notice Smallest direct amount and smallest average split share for `token`.
    function minShareOf(address token) public view returns (uint256) {
        return tokenListed[token] ? minShare[token] : MIN_SHARE;
    }

    function getPacket(uint256 id) external view returns (Packet memory) {
        return _packet(id);
    }

    function getSlot(uint256 id, uint256 index) external view returns (address who, uint256 blockNum) {
        Slot storage s = _slots[id][index];
        return (s.who, s.blockNum);
    }

    /// @notice Current heat of an address, in points.
    function heatOf(address who) public view returns (uint256) {
        uint256 until = heatUntil[who];
        if (until <= block.timestamp) return 0;
        return (until - block.timestamp + heatPeriod - 1) / heatPeriod;
    }

    /// @notice Earliest timestamp at which `who` may grab packet `id`.
    function eligibleAt(uint256 id, address who) external view returns (uint256) {
        return _eligibleAt(_packet(id), who);
    }

    /// @notice Number of reserved slots that `open` could pay right now.
    function openable(uint256 id) external view returns (uint256 n) {
        Packet storage p = _packet(id);
        for (uint256 i = p.opened; i < p.grabbed; ++i) {
            if (_slots[id][i].blockNum >= block.number) break;
            ++n;
        }
    }

    /// @notice The 32-byte value a claim key signs (as an EIP-191 personal message) for `who`.
    function claimDigest(uint256 id, address who) public view returns (bytes32) {
        return keccak256(abi.encode("AgentHongbao.grab", block.chainid, address(this), id, who));
    }

    // -------------------------------------------------------------- internals

    function _packet(uint256 id) private view returns (Packet storage p) {
        p = _packets[id];
        if (p.creator == address(0)) revert NoPacket();
    }

    function _checkCommon(address token, uint64 expiry, string calldata memo) private view {
        if (!tokenAllowed(token)) revert TokenNotAllowed();
        if (expiry < block.timestamp + MIN_TTL || expiry > block.timestamp + MAX_TTL) revert BadExpiry();
        if (bytes(memo).length > MAX_MEMO) revert BadMemo();
    }

    function _handleHashOf(address who) private view returns (bytes32) {
        bytes memory handle = bytes(registry.handleOf(who));
        if (handle.length == 0) revert NoAgentId();
        return keccak256(handle);
    }

    function _claimDirect(uint256 id, bytes32 h) private returns (uint256 amount) {
        Packet storage p = _packets[id];
        if (p.creator == address(0) || p.kind != Kind.Direct || block.timestamp >= p.expiry) return 0;
        amount = directAmount[id][h];
        if (amount == 0) return 0;
        directAmount[id][h] = 0;
        p.remaining -= uint128(amount);
        p.grabbed += 1;
        p.opened += 1;
        emit DirectClaimed(id, h, msg.sender, amount);
        _pay(p.token, msg.sender, amount);
    }

    /// @param firstGas Gas required before opening the first slot (0: always try one);
    ///                 every further slot requires OPEN_GAS.
    function _open(uint256 id, Packet storage p, uint256 max, uint256 firstGas) private returns (uint256 done) {
        if (!p.lucky) return 0;
        uint256 i = p.opened;
        uint256 grabbed = p.grabbed;
        uint256 shares = p.shares;
        uint256 remaining = p.remaining;
        uint256 forfeited = p.forfeited;
        uint256 floor = p.unit;
        address token = p.token;

        while (i < grabbed && done < max) {
            if (gasleft() < (done == 0 ? firstGas : OPEN_GAS)) break;
            Slot memory s = _slots[id][i];
            // The slot's block is not finished yet: its hash does not exist. Stop, do not floor.
            if (s.blockNum >= block.number) break;

            bytes32 h = _blockHash(s.blockNum);
            uint256 left = shares - i; // shares not yet paid, including this one
            uint256 spare = remaining - floor * left; // pool above the floors still owed
            uint256 amount;
            if (h == bytes32(0)) {
                // Hash aged out: no re-roll, floor only. The rest of this slot's expected share goes
                // back to the creator, so later slots (and the last one) gain nothing from the delay.
                amount = floor;
                uint256 forfeit = spare / left;
                forfeited += forfeit;
                remaining -= forfeit;
            } else if (left == 1) {
                amount = remaining;
            } else {
                // Each unpaid share keeps its floor; the rest is drawn uniformly up to twice the mean.
                amount = floor + uint256(keccak256(abi.encode(h, id, i, s.who))) % ((2 * spare) / left + 1);
            }
            remaining -= amount;
            emit Opened(id, i, s.who, amount, h == bytes32(0));
            // State is written back before each external call.
            p.remaining = uint128(remaining);
            p.forfeited = uint128(forfeited);
            p.opened = uint32(i + 1);
            _pay(token, s.who, amount);
            ++i;
            ++done;
        }
    }

    /// @dev Hash of a past block: the opcode for the last 256, the history contract up to 8191.
    ///      Returns 0 when the hash cannot be retrieved any more.
    function _blockHash(uint256 n) private view returns (bytes32 h) {
        h = blockhash(n);
        if (h == bytes32(0) && block.number - n <= HISTORY_WINDOW) {
            (bool ok, bytes memory ret) = HISTORY.staticcall{gas: 100_000}(abi.encode(n));
            if (ok && ret.length == 32) h = abi.decode(ret, (bytes32));
        }
    }

    function _eligibleAt(Packet storage p, address who) private view returns (uint256) {
        if (p.kind != Kind.Public || p.heatStep == 0) return p.createdAt;
        uint256 delay = heatOf(who) * p.heatStep;
        uint256 cap = (uint256(p.expiry) - p.createdAt) / 2; // never locked out for the whole lifetime
        return p.createdAt + (delay < cap ? delay : cap);
    }

    function _heatUp(address who) private {
        uint256 until = heatUntil[who];
        if (until < block.timestamp) until = block.timestamp;
        heatUntil[who] = uint64(until + heatPeriod);
    }

    function _coolDown(address who) private {
        uint256 until = heatUntil[who];
        if (until > block.timestamp) heatUntil[who] = uint64(until - heatPeriod);
    }

    function _collect(address token, uint256 amount) private {
        if (token == address(0)) {
            if (msg.value != amount) revert BadAmount();
            return;
        }
        if (msg.value != 0) revert BadAmount();
        uint256 beforeBal = _balanceOf(token);
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amount)); // transferFrom
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        if (_balanceOf(token) - beforeBal != amount) revert BadAmount();
    }

    function _balanceOf(address token) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || ret.length < 32) revert TransferFailed();
        return abi.decode(ret, (uint256));
    }

    /// @dev Push a payout; if the recipient cannot take it, record it for `withdraw`. Never reverts,
    ///      so one bad recipient cannot block the slots queued behind it.
    function _pay(address token, address to, uint256 amount) private {
        if (amount == 0) return;
        if (!_send(token, to, amount, token == address(0) ? PUSH_GAS : TOKEN_GAS)) {
            owed[to][token] += amount;
            emit Credited(to, token, amount);
        }
    }

    /// @param gasCap Gas forwarded to the native-coin recipient or the token contract.
    function _send(address token, address to, uint256 amount, uint256 gasCap) private returns (bool ok) {
        if (token == address(0)) {
            assembly ("memory-safe") {
                ok := call(gasCap, to, amount, 0, 0, 0, 0)
            }
        } else {
            bytes memory data = abi.encodeWithSelector(0xa9059cbb, to, amount); // transfer
            uint256 result;
            assembly ("memory-safe") {
                ok := call(gasCap, token, 0, add(data, 0x20), mload(data), 0, 0x20)
                result := mload(0)
                // Accept "no return data" and "returned true"; anything else is a failure.
                if and(ok, gt(returndatasize(), 0)) { ok := and(gt(returndatasize(), 0x1f), eq(result, 1)) }
            }
        }
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > HALF_ORDER || (v != 27 && v != 28)) return address(0);
        return ecrecover(keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)), v, r, s);
    }
}

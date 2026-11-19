// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Test stand-in for the Agent ID registry: one handle per address, never removed.
contract MockRegistry {
    mapping(address => string) public handleOf;
    mapping(bytes32 => address) public ownerOfLabel;

    function register(string calldata handle, address to) external {
        require(bytes(handleOf[to]).length == 0, "has handle");
        bytes32 label = keccak256(bytes(handle));
        require(ownerOfLabel[label] == address(0), "taken");
        handleOf[to] = handle;
        ownerOfLabel[label] = to;
    }

    function balanceOf(address owner) external view returns (uint256) {
        return bytes(handleOf[owner]).length == 0 ? 0 : 1;
    }

    function ownerOfHandle(string calldata handle) external view returns (address) {
        return ownerOfLabel[keccak256(bytes(handle))];
    }
}

contract MockToken {
    string public constant name = "Mock USD";
    string public constant symbol = "mUSD";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public feeBps; // > 0 turns it into a fee-on-transfer token
    mapping(address => bool) public blocked;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setFee(uint256 bps) external {
        feeBps = bps;
    }

    function setBlocked(address who, bool b) external {
        blocked[who] = b;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(!blocked[to], "blocked");
        balanceOf[from] -= amount;
        balanceOf[to] += amount - (amount * feeBps) / 10000;
    }
}

/// @dev Serves a deterministic fake hash for any block in the EIP-2935 window, reverts outside it.
contract MockHistory {
    fallback(bytes calldata data) external returns (bytes memory) {
        uint256 n = abi.decode(data, (uint256));
        require(n < block.number && block.number - n <= 8191, "out of window");
        return abi.encode(keccak256(abi.encode("history", n)));
    }
}

interface IHongbao {
    function grab(uint256 id, bytes calldata sig) external;
    function claimDirect(uint256 id) external returns (uint256);
    function open(uint256 id, uint256 max) external returns (uint256);
    function withdraw(address token, address to) external;
}

/// @dev An Agent ID holder that refuses native coin, and can try to re-enter while being paid.
contract StubbornHolder {
    IHongbao public immutable hongbao;
    bool public accept;
    uint256 public reenterId;
    bool public reentered;
    bool public reenterOk;

    constructor(IHongbao h) {
        hongbao = h;
    }

    function setAccept(bool a) external {
        accept = a;
    }

    function setReenter(uint256 id) external {
        reenterId = id;
    }

    function grab(uint256 id) external {
        hongbao.grab(id, "");
    }

    function claimDirect(uint256 id) external {
        hongbao.claimDirect(id);
    }

    function withdraw(address token, address to) external {
        hongbao.withdraw(token, to);
    }

    receive() external payable {
        if (reenterId != 0) {
            reentered = true;
            try hongbao.open(reenterId, 10) {
                reenterOk = true;
            } catch {}
        }
        require(accept, "no thanks");
    }
}

interface IHongbaoFull {
    function grab(uint256 id, bytes calldata sig) external;
    function open(uint256 id, uint256 max) external returns (uint256);
    function refund(uint256 id) external;
}

/// @dev An arbitrary token that turns hostile when paying out. Collecting (transferFrom) is
///      always honest; `transfer` behaves according to `mode`.
contract HostileToken {
    enum Mode {
        Honest,
        Revert,
        ReturnFalse,
        BurnGas,
        Reenter,
        NoReturn,
        HugeReturn
    }

    string public symbol = "USDT"; // spoofs a well-known symbol
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    Mode public mode;
    IHongbaoFull public target;
    uint256 public targetId;
    bool public reenterFailed;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setMode(Mode m) external {
        mode = m;
    }

    function setTarget(IHongbaoFull t, uint256 id) external {
        target = t;
        targetId = id;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transfer(address to, uint256 amount) external {
        Mode m = mode;
        if (m == Mode.Revert) revert("nope");
        if (m == Mode.BurnGas) {
            while (true) {}
        }
        if (m == Mode.Reenter) {
            try target.open(targetId, 10) {} catch {
                reenterFailed = true;
            }
            try target.refund(targetId) {} catch {}
        }
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        if (m == Mode.ReturnFalse) {
            assembly {
                mstore(0, 0)
                return(0, 32)
            }
        }
        if (m == Mode.NoReturn) {
            assembly {
                return(0, 0)
            }
        }
        if (m == Mode.HugeReturn) {
            assembly {
                mstore(0, 1)
                return(0, 100000)
            }
        }
        assembly {
            mstore(0, 1)
            return(0, 32)
        }
    }
}

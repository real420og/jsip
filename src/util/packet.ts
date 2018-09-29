import { EthHdr } from "../ethernet/index";
import { handleIP } from "../ethernet/ip/stack";
import { handleEthernet } from "../ethernet/stack";
import { IInterface } from "../interface/index";

const ethDummy = new EthHdr();

export function handlePacket(data: ArrayBuffer, iface: IInterface) {
    if (iface.useEthernet()) {
        handleEthernet(data, iface);
    } else {
        handleIP(data, 0, ethDummy, iface);
    }
}

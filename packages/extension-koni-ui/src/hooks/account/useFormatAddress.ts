// Copyright 2019-2022 @subwallet/extension-koni-ui authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { AbstractAddressJson } from '@subwallet/extension-base/background/types';
import { findNetworkJsonByGenesisHash, reformatAddress } from '@subwallet/extension-koni-ui/utils';
import { useCallback } from 'react';

import { useSelector } from '../common';

const useFormatAddress = (addressPrefix?: number) => {
  const { chainInfoMap } = useSelector((state) => state.chainStore);

  return useCallback((item: AbstractAddressJson): string => {
    let addPrefix = 42;

    if (addressPrefix !== undefined) {
      addPrefix = addressPrefix;
    }

    if (item.originGenesisHash) {
      const network = findNetworkJsonByGenesisHash(chainInfoMap, item.originGenesisHash);

      if (network) {
        addPrefix = network.substrateInfo?.addressPrefix ?? addPrefix;
      }
    }

    return reformatAddress(item.address, addPrefix);
  }, [addressPrefix, chainInfoMap]);
};

export default useFormatAddress;

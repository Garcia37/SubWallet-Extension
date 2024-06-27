// Copyright 2019-2022 @subwallet/extension-web-ui authors & contributors
// SPDX-License-Identifier: Apache-2.0

import type { Chain } from '@subwallet/extension-chains/types';

import { RequestSign } from '@subwallet/extension-base/background/types';
import { _isRuntimeUpdated, getMetadataHash } from '@subwallet/extension-base/utils';
import { isRawPayload } from '@subwallet/extension-web-ui/utils';
import { useEffect, useMemo, useState } from 'react';

import { TypeRegistry } from '@polkadot/types';
import { ExtrinsicPayload } from '@polkadot/types/interfaces';
import { SignerPayloadJSON } from '@polkadot/types/types';

import { useGetChainInfoByGenesisHash } from '../../chain';

const registry = new TypeRegistry();

interface Result {
  payload: ExtrinsicPayload | string;
  hashLoading: boolean;
  missingData: boolean;
}

const useParseSubstrateRequestPayload = (chain: Chain | null, request?: RequestSign, isLedger?: boolean): Result => {
  const chainInfo = useGetChainInfoByGenesisHash(chain?.genesisHash || '');
  const chainSlug = useMemo(() => chainInfo?.slug || '', [chainInfo]);
  const missingData = useMemo(() => {
    if (!request) {
      return false;
    }

    const payload = request.payload;

    if (isRawPayload(payload)) {
      return false;
    } else {
      if (!isLedger) {
        return false;
      }

      const runtimeUpdated = _isRuntimeUpdated(payload.signedExtensions);

      return runtimeUpdated && (payload.mode !== 1 || !payload.metadataHash);
    }
  }, [request, isLedger]);

  const [metadataHash, setMetadataHash] = useState<string>(''); // Have value only when missingData is true
  const [hashLoading, setHashLoading] = useState(true);

  const payload = useMemo<ExtrinsicPayload | string>(() => {
    if (!request) {
      return '';
    } else {
      const payload = request.payload;

      if (isRawPayload(payload)) {
        return payload.data;
      } else {
        const _registry = chain?.registry || registry;

        _registry.setSignedExtensions(payload.signedExtensions, chain?.definition.userExtensions); // Important

        const _payload: SignerPayloadJSON = {
          ...payload
        };

        if (metadataHash) {
          _payload.mode = 1;
          _payload.metadataHash = `0x${metadataHash}`;
        }

        return _registry.createType('ExtrinsicPayload', _payload, { version: _payload.version });
      }
    }
  }, [chain, metadataHash, request]);

  // For metadata digest hash
  useEffect(() => {
    let cancel = false;

    if (!missingData) {
      setHashLoading(false);

      return;
    } else {
      setHashLoading(true);

      getMetadataHash(chainSlug)
        .then((metadataHash) => {
          setMetadataHash(metadataHash);
        })
        .catch(console.log)
        .finally(() => {
          if (!cancel) {
            setHashLoading(false);
          }
        });
    }

    return () => {
      cancel = true;
    };
  }, [chainSlug, missingData]);

  return useMemo(() => ({
    hashLoading,
    payload,
    missingData
  }), [hashLoading, missingData, payload]);
};

export default useParseSubstrateRequestPayload;

// Copyright 2019-2022 @polkadot/extension-ui authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { StakeUnlockingJson } from '@subwallet/extension-koni-ui/stores/types';

const initialState = {
  details: {}
} as StakeUnlockingJson;

const stakeUnlockingSlice = createSlice({
  initialState,
  name: 'stakeUnlockingInfo',
  reducers: {
    update (state, action: PayloadAction<StakeUnlockingJson>) {
      const payload = action.payload;

      state.details = payload.details;
    }
  }
});

export const { update } = stakeUnlockingSlice.actions;
export default stakeUnlockingSlice.reducer;

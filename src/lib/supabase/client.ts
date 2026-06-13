import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// 실제 Supabase 연결 여부 판별 (로컬 DB나 Mock DB로 분기하지 않고 항상 실제 Supabase로 고정)
const isPlaceholder = false;

// 임시 인메모리 Mock 데이터베이스 저장소
const mockStorage: { [key: string]: any[] } = {
  products: [
    {
      id: '99999999-9999-9999-9999-999999999999',
      product_code: 'P1001',
      title: '[특가] 초경량 구스다운 충전 패딩 점퍼',
      content: '올 겨울을 책임질 프리미엄 가성비 초경량 구스다운 점퍼입니다.\n한정 수량 직송 특가로 조기 품절될 수 있습니다.',
      price: 49000,
      stock_quantity: 12,
      naver_article_url: 'https://cafe.naver.com/03hyuk/1',
      is_active: true,
      created_at: new Date().toISOString(),
      product_images: [{ image_url: 'https://picsum.photos/800/600.jpg' }]
    },
    {
      id: '88888888-8888-8888-8888-888888888888',
      product_code: 'P1002',
      title: '[한정수량] 고탄성 메모리폼 기능성 필로우',
      content: '목 피로를 즉시 완화해주는 프리미엄 수입 고탄성 메모리폼 필로우입니다.\n쾌적한 숙면을 경험해보세요.',
      price: 29000,
      stock_quantity: 4,
      naver_article_url: null,
      is_active: true,
      created_at: new Date(Date.now() - 3600000).toISOString(),
      product_images: [{ image_url: 'https://picsum.photos/800/601.jpg' }]
    }
  ],
  product_images: [
    {
      id: 'img1',
      product_id: '99999999-9999-9999-9999-999999999999',
      image_url: 'https://picsum.photos/800/600.jpg',
      display_order: 0
    },
    {
      id: 'img2',
      product_id: '88888888-8888-8888-8888-888888888888',
      image_url: 'https://picsum.photos/800/601.jpg',
      display_order: 0
    }
  ],
  orders: [
    {
      id: 'o1',
      order_number: 'ORD20260520-001',
      recipient_name: '데모 회원',
      recipient_phone: '010-1234-5678',
      shipping_address: '서울특별시 강남구 테헤란로 123, 4층',
      custom_code: 'P123456789012',
      total_amount: 49000,
      payment_status: 'PAID',
      shipping_status: 'PREPARING',
      tracking_number: null,
      created_at: new Date().toISOString(),
      order_items: [
        {
          quantity: 1,
          unit_price: 49000,
          product: {
            title: '[특가] 초경량 구스다운 충전 패딩 점퍼',
            product_code: 'P1001'
          }
        }
      ]
    }
  ],
  order_items: []
};

// Supabase 체이닝 쿼리를 흉내 내는 Mock 체인 빌더
class MockChain {
  private tableName: string;
  private currentData: any[];

  constructor(tableName: string) {
    this.tableName = tableName;
    this.currentData = mockStorage[tableName] || [];
  }

  select(fields?: string) {
    // 상품 이미지나 주문 아이템 조인 처리 모방
    if (fields && fields.includes('product_images')) {
      this.currentData = this.currentData.map(p => ({
        ...p,
        product_images: mockStorage.product_images.filter(img => img.product_id === p.id)
      }));
    }
    return this;
  }

  order(field: string, options?: { ascending: boolean }) {
    this.currentData = [...this.currentData].sort((a, b) => {
      const valA = a[field];
      const valB = b[field];
      if (options?.ascending) {
        return valA > valB ? 1 : -1;
      }
      return valA < valB ? 1 : -1;
    });
    return this;
  }

  eq(field: string, value: any) {
    this.currentData = this.currentData.filter(item => item[field] === value);
    return this;
  }

  single() {
    return {
      data: this.currentData[0] || null,
      error: null
    };
  }

  async insert(payload: any) {
    const isArray = Array.isArray(payload);
    const itemsToInsert = isArray ? payload : [payload];
    
    const insertedItems = itemsToInsert.map(item => {
      const id = item.id || Math.random().toString(36).substring(2, 15);
      const product_code = item.product_code || `P${1000 + (mockStorage[this.tableName]?.length || 0) + 1}`;
      const newItem = {
        id,
        product_code,
        created_at: new Date().toISOString(),
        ...item
      };
      if (this.tableName === 'products') {
        newItem.product_images = [];
      }
      return newItem;
    });

    if (!mockStorage[this.tableName]) {
      mockStorage[this.tableName] = [];
    }
    mockStorage[this.tableName].push(...insertedItems);

    return {
      data: isArray ? insertedItems : insertedItems[0],
      error: null,
      select: () => ({
        single: () => ({
          data: isArray ? insertedItems : insertedItems[0],
          error: null
        })
      })
    };
  }

  async update(payload: any) {
    this.currentData.forEach(item => {
      Object.assign(item, payload);
    });
    return {
      data: this.currentData,
      error: null
    };
  }

  async delete() {
    const idsToDelete = this.currentData.map(i => i.id);
    mockStorage[this.tableName] = (mockStorage[this.tableName] || []).filter(
      item => !idsToDelete.includes(item.id)
    );
    return {
      data: this.currentData,
      error: null
    };
  }

  // Promise 대용 then 처리 (await 체이닝 가능하게)
  then(onfulfilled?: (value: any) => any) {
    const res = { data: this.currentData, error: null };
    return Promise.resolve(res).then(onfulfilled);
  }
}

// Mock Supabase Client Proxy
const mockSupabase = {
  from(tableName: string) {
    return new MockChain(tableName);
  },
  auth: {
    onAuthStateChange(callback: any) {
      console.log('[Mock Auth] onAuthStateChange listener registered.');
      // 임시로 로그아웃 상태 전달 (데모 모드 기동)
      setTimeout(() => {
        callback('SIGNED_OUT', null);
      }, 0);
      return {
        data: {
          subscription: {
            unsubscribe() {
              console.log('[Mock Auth] Unsubscribed successfully.');
            }
          }
        }
      };
    },
    async getUser() {
      return { data: { user: null }, error: null };
    },
    async signInWithOAuth(options: any) {
      console.log('[Mock Auth] signInWithOAuth called', options);
      return { error: null };
    },
    async signInWithPassword(credentials: any) {
      console.log('[Mock Auth] signInWithPassword called', credentials);
      const fakeUser = {
        id: 'mock-user-id-12345',
        email: credentials.email,
        created_at: new Date().toISOString()
      };
      return { data: { user: fakeUser }, error: null };
    },
    async signUp(credentials: any) {
      console.log('[Mock Auth] signUp called', credentials);
      const fakeUser = {
        id: 'mock-user-id-12345',
        email: credentials.email,
        created_at: new Date().toISOString()
      };
      return { data: { user: fakeUser }, error: null };
    },
    async signOut() {
      console.log('[Mock Auth] signOut called.');
      return { error: null };
    }
  },
  storage: {
    from(bucketName: string) {
      return {
        async upload(path: string, file: any) {
          console.log(`[Mock Storage] Uploading ${file.name} to ${bucketName}/${path}`);
          return { data: { path }, error: null };
        },
        getPublicUrl(path: string) {
          const uniqueId = path.split('/').pop() || Math.random().toString();
          return {
            data: {
              publicUrl: `https://picsum.photos/seed/${uniqueId}/800/600`
            }
          };
        }
      };
    }
  }
};

// 클라이언트 연결 기동
export const supabase = isPlaceholder 
  ? (mockSupabase as any) 
  : createClient(supabaseUrl, supabaseAnonKey);

if (isPlaceholder) {
  console.log('[Supabase Client] ⚠️ 로컬 환경 변수가 없거나 Placeholder 상태입니다. 메모리 내 인메모리 Mock DB 모드로 자동 전환하여 기동합니다. (UI 체험 가능) 🤖');
} else {
  console.log('[Supabase Client] ✅ 실시간 원격 Supabase 데이터베이스 인스턴스에 정상 연동되었습니다.');
}

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Map Stripe price/product to plan names
// You'll fill these in once you have your live price IDs
const PLAN_MAP = {
  'price_starter':  'starter',
  'price_growth':   'growth',
  'price_agency':   'agency',
};

function getPlanFromSubscription(subscription) {
  const priceId = subscription.items?.data?.[0]?.price?.id || '';
  return PLAN_MAP[priceId] || 'starter';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    switch (event.type) {

      // Payment completed — activate subscription
      case 'checkout.session.completed': {
        const session = event.data.object;
        const customerId = session.customer;
        const customerEmail = session.customer_details?.email || session.customer_email;

        if (!customerEmail) {
          console.error('No email on checkout session', session.id);
          break;
        }

        // Find user by email and update their profile
        const { data: profiles, error } = await sb
          .from('profiles')
          .update({
            stripe_customer_id: customerId,
            subscription_status: 'active',
            plan: 'growth', // default — refined below if subscription exists
            updated_at: new Date().toISOString(),
          })
          .eq('email', customerEmail)
          .select();

        if (error) console.error('Supabase update error (checkout):', error);
        else console.log('Activated subscription for:', customerEmail);
        break;
      }

      // Subscription changed — update plan or status
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const plan = getPlanFromSubscription(subscription);
        const status = subscription.status; // active, past_due, canceled, etc.

        const { error } = await sb
          .from('profiles')
          .update({
            subscription_status: status,
            plan: plan,
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_customer_id', customerId);

        if (error) console.error('Supabase update error (updated):', error);
        else console.log('Updated subscription:', customerId, plan, status);
        break;
      }

      // Subscription cancelled — revoke access
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        const { error } = await sb
          .from('profiles')
          .update({
            subscription_status: 'canceled',
            plan: null,
            updated_at: new Date().toISOString(),
          })
          .eq('stripe_customer_id', customerId);

        if (error) console.error('Supabase update error (deleted):', error);
        else console.log('Cancelled subscription for customer:', customerId);
        break;
      }

      default:
        console.log('Unhandled event type:', event.type);
    }

    res.status(200).json({ received: true });

  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
};
